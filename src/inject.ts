// A14: getting the helper into the page without breaking the page.
//
// The obvious implementation — concatenate `<script>…</script>` in front of the author's
// HTML — puts the doctype out of position zero and renders EVERY document in quirks
// mode. Box model changes, layouts silently break, and no test in the original plan
// caught it. That is an I1 violation produced by an implementation shortcut, so the
// injection goes through HTMLRewriter and the canary asserts `document.compatMode`.

export interface PreparedContent {
	html: string;
	/** Surfaced to the agent through the A3 `warnings` mechanism, so a document that was
	 *  quietly altered says so on the next read rather than failing mysteriously. */
	warnings: Warning[];
}

export interface Warning {
	code:
		| "added_doctype"
		| "stripped_meta_csp"
		| "stripped_base"
		| "dark_mode_no_background"
		| "no_viewport";
	message: string;
}

/**
 * Two failures the author structurally cannot see, detected at publish time.
 *
 * Both were first reported as documentation gaps. Documentation is the wrong remedy: the
 * manual is fetched once, before any HTML is written, and these bugs are found by the person
 * who opens the document — who has no channel back. `warnings` rides every read, so the agent
 * meets this while it can still act. The content is already being parsed here, so the check
 * is free.
 *
 * Deliberately conservative. A false positive costs an agent one confusing sentence; missing
 * the real thing costs a person an unreadable page.
 */
function renderingWarnings(html: string): Warning[] {
	const found: Warning[] = [];

	// Both checks run over CSS ONLY — the contents of <style> elements and style attributes.
	// Scanning the whole document produced two measured false-positive classes: a page that
	// themes itself in JavaScript (`matchMedia("(prefers-color-scheme: dark)")`) tripped the
	// dark trigger from its script, and base64 data: URIs tripped the viewport check, because
	// `+` `/` `=` are word boundaries so `…/3vh+…` matches `\b3vh\b`. That hit 1 in 10 sample
	// documents at 500 KB — and `guide.md` tells authors to embed assets as data: URIs, so the
	// collision was designed in.
	const css = styleText(html);

	// The frame's canvas is `background: #fff` (shell.css) in every theme, because content
	// cannot read the shell's theme. An author whose dark rules set `color` and not
	// `background` ships light text on white, and sees nothing wrong locally where the page
	// background follows their own OS setting.
	const dark = darkBlocks(css);
	if (dark !== "") {
		// The question is whether the canvas is painted IN DARK MODE, not whether it is painted
		// at all. `body{background:#fff}` plus a dark block that only sets `color` paints the
		// canvas white and then writes light text on it — the exact reported bug — and a check
		// for "painted anywhere" calls that page correct.
		//
		// The exception is the custom-property pattern, `body{background:var(--bg)}` with
		// `--bg` retuned inside the dark block. That is idiomatic and correct, and warning on
		// it would teach agents to ignore warnings.
		const themedByVariable = /background(-color)?\s*:[^;}]*var\(/i.test(css) && paintsCanvas(css);
		// A canvas painted dark for BOTH themes is fine: dark text rules sit on a dark page, and
		// warning would be a false positive. A canvas painted LIGHT for both themes is exactly
		// the reported bug. So the colour decides, and only when it is a literal we can read.
		const alreadyDark = canvasIsDark(css);
		if (!paintsCanvas(dark) && !themedByVariable && !alreadyDark) {
			found.push({
				code: "dark_mode_no_background",
				message:
					"Your dark-mode block never paints a background on the canvas (html, body or :root). The frame you publish into is white in every theme and cannot read the viewer's, so dark rules that only change `color` produce light text on a white page. Paint the canvas inside the same block, or drive it from a custom property you retune there.",
			});
		}
	}

	// The shell sizes the frame to the content's own scrollHeight, so the frame has no viewport
	// that scrolls. `100vh` is the sharp one: it is circular, and content outside the block
	// grows the document on every resize round trip until the clamp.
	const viewportUnits = /\b\d*\.?\d+(vh|dvh|svh|lvh)\b/i.test(css);
	const fixedOrSticky = /position\s*:\s*(fixed|sticky)/i.test(css);
	if (viewportUnits || fixedOrSticky) {
		const parts: string[] = [];
		if (viewportUnits)
			parts.push(
				"viewport height units (vh/dvh/svh) are circular here and will grow the page on every resize until it is clamped",
			);
		if (fixedOrSticky)
			// Deliberately hedged. `sticky` DOES work inside a scroll container the author makes
			// themselves, and `fixed` has defined behaviour; what is absent is the outer viewport
			// people assume. A warning that overstates is worse than none.
			parts.push(
				"position: fixed pins to the frame rather than to the window the reader is scrolling, and position: sticky does nothing unless you made your own scrolling container",
			);
		found.push({
			code: "no_viewport",
			message: `The frame is sized to your content's height, so there is no viewport that scrolls: ${parts.join("; ")}. Size in rem, % or px, and let the page be as tall as it is.`,
		});
	}

	return found;
}

/** Every `<style>` body and `style=` attribute value, concatenated. Bounded, single pass. */
function styleText(html: string): string {
	const parts: string[] = [];
	for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) parts.push(match[1] ?? "");
	for (const match of html.matchAll(/\sstyle\s*=\s*"([^"]{0,2000})"/gi)) parts.push(`body{${match[1] ?? ""}}`);
	for (const match of html.matchAll(/\sstyle\s*=\s*'([^']{0,2000})'/gi)) parts.push(`body{${match[1] ?? ""}}`);
	return parts.join("\n");
}

/**
 * Walk every rule exactly once, left to right.
 *
 * The obvious implementations are both quadratic and both shipped here before this one. A
 * selector-through-declaration regex (`[^{}]*\{`) rescans the remaining megabytes from every
 * candidate. Replacing it with `indexOf("}", open + 1)` per candidate is quadratic on the
 * opposite shape: many `{` and one `}`, where every iteration scans to the end. That measured
 * 903 ms at 400 KB and roughly 90 s at the 4 MB content cap — and `prepareContent` runs on the
 * UNAUTHENTICATED `GET /c/:id` path, in a single-threaded process, so one document stalls
 * every tenant.
 *
 * This pass touches each character once and slices only bounded windows.
 */
function forEachRule(css: string, visit: (selector: string, declarations: string) => boolean): boolean {
	// Indices, not strings. Pushing a bounded prelude string per `{` traded the CPU blowup for
	// a memory one: 4 MB of `{` with no `}` is four million entries.
	const preludeStarts: number[] = [];
	let segmentStart = 0;
	for (let i = 0; i < css.length; i++) {
		const code = css.charCodeAt(i);
		if (code === 123 /* { */) {
			// Real CSS does not nest a thousand deep; anything that does is not worth scanning.
			if (preludeStarts.length >= MAX_NESTING) return false;
			preludeStarts.push(Math.max(segmentStart, i - 200));
			preludeStarts.push(i);
			segmentStart = i + 1;
		} else if (code === 125 /* } */) {
			const preludeEnd = preludeStarts.pop();
			const preludeStart = preludeStarts.pop();
			if (preludeStart !== undefined && preludeEnd !== undefined) {
				if (visit(css.slice(preludeStart, preludeEnd), css.slice(segmentStart, i))) return true;
			}
			segmentStart = i + 1;
		}
	}
	return false;
}

/** Deeper than any real stylesheet; a document that nests further is refusing to be parsed. */
const MAX_NESTING = 1000;

/** The contents of every `@media (prefers-color-scheme: dark)` block. */
function darkBlocks(css: string): string {
	// Same shape as forEachRule: numbers only, bounded depth. Negative marks a dark block.
	const openAt: number[] = [];
	const out: string[] = [];
	let segmentStart = 0;
	for (let i = 0; i < css.length; i++) {
		const code = css.charCodeAt(i);
		if (code === 123 /* { */) {
			if (openAt.length >= MAX_NESTING) break;
			const prelude = css.slice(Math.max(segmentStart, i - 200), i);
			const isDark = /prefers-color-scheme\s*:\s*dark/i.test(prelude);
			openAt.push(isDark ? -(i + 1) : i + 1);
			segmentStart = i + 1;
		} else if (code === 125 /* } */) {
			const marker = openAt.pop();
			if (marker !== undefined && marker < 0) out.push(css.slice(-marker, i));
			segmentStart = i + 1;
		}
	}
	return out.join("\n");
}

/**
 * Does any rule paint a background on the canvas itself?
 *
 * `html`, `body`, `:root`, `body.dark`, `body:has(…)`, `html, body` all count. `:root` is
 * included because it IS the html element and is the form an agent is most likely to write,
 * custom properties living there — excluding it flagged correct pages.
 *
 * `body .card`, `body > main` and `.wrap body` do not count: those paint something inside the
 * page while the canvas behind it stays white.
 */
function paintsCanvas(css: string): boolean {
	return forEachRule(css, (selector, declarations) => {
		if (!/background(-color)?\s*:/i.test(declarations)) return false;
		for (const one of selector.split(",")) {
			// Cut at the last `>` so the left side of a child combinator is dropped: `body > main`
			// is not the canvas, while `html > body` is.
			const angle = one.lastIndexOf(">");
			const tail = angle === -1 ? one : one.slice(angle + 1);
			if (/^\s*(html|body|:root)(?:[.#:[][^\s>+~,]*)*\s*$/i.test(tail)) return true;
		}
		return false;
	});
}


const DOCTYPE_AT_START = /^\s*<!doctype\b[^>]*>/i;

/**
 * Wrap the helper for injection. Kept as one `<script>` with no attributes so that the
 * author's own `script-src 'unsafe-inline'` budget is all it needs.
 */
function scriptTag(helper: string): string {
	return `<script data-vaiven-helper>${helper}</script>`;
}

/**
 * Inject the helper immediately after `<head>`, preserving the doctype at position 0.
 *
 * Three cases, because model-authored HTML is not guaranteed to be well-formed:
 *   1. Has a doctype and a `<head>` — rewrite, prepend into head. The common path.
 *   2. Has a doctype, no `<head>` — synthesise one after the doctype.
 *   3. No doctype at all — add one and warn. Without it the page is in quirks mode
 *      regardless of what we inject, which breaks the authoring ceiling for everyone.
 */
export async function prepareContent(rawHtml: string, helper: string): Promise<PreparedContent> {
	const warnings: Warning[] = [];
	let html = rawHtml;

	// An author's meta CSP composes as a UNION with our header, so it can only ever
	// tighten the policy — including tightening it enough to disable our own helper.
	// Claude writes these routinely in artifacts, so strip and say so.
	const metaCsp =
		/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi;
	if (metaCsp.test(html)) {
		html = html.replace(metaCsp, "");
		warnings.push({
			code: "stripped_meta_csp",
			message:
				"Removed a <meta http-equiv=\"Content-Security-Policy\"> tag. Policies compose as a union, so yours could only further restrict the page — including disabling the Vaiven helper. The response header already sets the policy.",
		});
	}

	// <base> rewrites relative URL resolution, including for the helper.
	const baseTag = /<base[^>]*>/gi;
	if (baseTag.test(html)) {
		html = html.replace(baseTag, "");
		warnings.push({
			code: "stripped_base",
			message:
				"Removed a <base> tag. It changes how every relative URL in the document resolves, including the helper's. Use absolute paths instead.",
		});
	}

	warnings.push(...renderingWarnings(html));

	const doctypeMatch = html.match(DOCTYPE_AT_START);

	if (!doctypeMatch) {
		// Case 3. Adding the doctype is not optional: without it the browser uses quirks
		// mode and the author's layout silently differs from what they wrote.
		warnings.push({
			code: "added_doctype",
			message:
				"Your content did not start with <!doctype html>, so one was added. Without it the browser renders in quirks mode and your layout will not match what you wrote.",
		});
		html = `<!doctype html>\n${html}`;
	}

	// Ask the PARSER whether a head exists, rather than testing the raw text. A regex
	// cannot tell `<head>` the element from `<head>` inside a comment, a string literal or
	// a textarea — and when it guessed wrong the rewriter's handler never fired, so the
	// helper was silently not injected at all: the frame never announces itself, the shell
	// waits on a skeleton forever, and read-only enforcement never runs.
	let injected = false;
	const rewritten = await new HTMLRewriter()
		.on("head", {
			element(element) {
				if (injected) return;
				injected = true;
				element.prepend(scriptTag(helper), { html: true });
			},
		})
		.transform(new Response(html))
		.text();

	if (injected) return { html: rewritten, warnings };

	// No head element in the parsed document: synthesise one after the doctype, leaving
	// the doctype exactly where it has to be.
	const match = html.match(DOCTYPE_AT_START)!;
	const doctype = match[0];
	const rest = html.slice(doctype.length);
	return { html: `${doctype}\n<head>${scriptTag(helper)}</head>${rest}`, warnings };
}

/**
 * Is the canvas painted a dark colour outside any theme block?
 *
 * Only literal colours are read — hex, `rgb()`, and the two keywords that actually appear.
 * Anything unreadable answers `false`, so the uncertain case warns rather than staying quiet:
 * a spurious warning costs a sentence, a missed one costs a person an unreadable page.
 */
function canvasIsDark(css: string): boolean {
	let dark = false;
	forEachRule(css, (selector, declarations) => {
		const match = /background(?:-color)?\s*:\s*([^;}]+)/i.exec(declarations);
		if (!match) return false;
		for (const one of selector.split(",")) {
			const angle = one.lastIndexOf(">");
			const tail = angle === -1 ? one : one.slice(angle + 1);
			if (!/^\s*(html|body|:root)(?:[.#:[][^\s>+~,]*)*\s*$/i.test(tail)) continue;
			const luminance = readLuminance(match[1] ?? "");
			// Later rules win in CSS, so keep looking rather than returning on the first hit.
			if (luminance !== null) dark = luminance < 0.4;
		}
		return false;
	});
	return dark;
}

/** Rough perceived lightness, 0 (black) to 1 (white). `null` when the value is not a literal. */
function readLuminance(value: string): number | null {
	const text = value.trim().toLowerCase();
	if (text.startsWith("#")) {
		const hex = text.slice(1).replace(/[^0-9a-f].*$/, "");
		const expanded =
			hex.length === 3 || hex.length === 4
				? hex
						.slice(0, 3)
						.split("")
						.map((c) => c + c)
						.join("")
				: hex.length >= 6
					? hex.slice(0, 6)
					: null;
		if (!expanded) return null;
		const r = Number.parseInt(expanded.slice(0, 2), 16);
		const g = Number.parseInt(expanded.slice(2, 4), 16);
		const b = Number.parseInt(expanded.slice(4, 6), 16);
		return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	}
	const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(text);
	if (rgb) {
		const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
		return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	}
	if (text.startsWith("black")) return 0;
	if (text.startsWith("white")) return 1;
	return null;
}
