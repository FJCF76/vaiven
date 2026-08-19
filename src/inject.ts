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

	// The frame's canvas is `background: #fff` (shell.css) in every theme, because content
	// cannot read the shell's theme. An author who writes a dark-mode block that sets `color`
	// and not `background` ships light text on white — and sees nothing wrong locally, where
	// the page background follows their own OS setting.
	if (/prefers-color-scheme\s*:\s*dark/i.test(html) && !paintsCanvas(html)) {
		found.push({
			code: "dark_mode_no_background",
			message:
				"Your content has a prefers-color-scheme: dark block but never paints a background on html or body. The frame you publish into is white in every theme and cannot read the viewer's, so dark rules that only change `color` produce light text on a white page. Set both, or set neither.",
		});
	}

	// The shell sizes the frame to the content's own scrollHeight, so the frame has no
	// viewport that scrolls. `100vh` is the sharp one: it is circular, and content outside the
	// block grows the document on every resize round trip until the clamp.
	const viewportUnits = /\b\d*\.?\d+(vh|dvh|svh|lvh)\b/i.test(html);
	const fixedOrSticky = /position\s*:\s*(fixed|sticky)/i.test(html);
	if (viewportUnits || fixedOrSticky) {
		const parts: string[] = [];
		if (viewportUnits)
			parts.push(
				"viewport height units (vh/dvh/svh) are circular here and will grow the page on every resize until it is clamped",
			);
		if (fixedOrSticky)
			// Deliberately hedged. `sticky` DOES work inside a scroll container the author makes
			// themselves, and `fixed` has defined behaviour; what is absent is the outer
			// viewport people assume. Claiming they "never work" would be false, and a warning
			// that is false is worse than no warning.
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

/**
 * Does any rule set a background on the canvas itself?
 *
 * Split on braces and inspect each rule rather than matching selector-through-declaration in
 * one regex. The regex form was quadratic — `[^{}]*\{` rescans the remaining megabytes from
 * every candidate when a document contains many `body` tokens and few braces, which a 4 MB
 * publish can turn into a stalled event loop. It was also wrong: `body .card { background }`
 * matched, so a page that paints a CARD and not the canvas counted as safe.
 *
 * `html`, `body`, `body.dark`, `body:has(...)`, `html, body` all count. `body .card`,
 * `body > main` and `.wrap body` do not — those paint something inside the page.
 */
function paintsCanvas(html: string): boolean {
	if (/<(html|body)[^>]{0,400}style=["'][^"']{0,400}background/i.test(html)) return true;

	let cursor = 0;
	while (cursor < html.length) {
		const open = html.indexOf("{", cursor);
		if (open === -1) return false;
		const close = html.indexOf("}", open + 1);
		if (close === -1) return false;

		// An at-rule (`@media`, `@supports`, `@layer`) opens a block that contains further
		// rules, so the next delimiter is another `{` rather than `}`. Descend into it instead
		// of reading its contents as declarations — nearly every dark-mode rule worth finding
		// lives one level inside `@media (prefers-color-scheme: dark)`, so a scanner that does
		// not nest finds none of them.
		const nextOpen = html.indexOf("{", open + 1);
		if (nextOpen !== -1 && nextOpen < close) {
			cursor = open + 1;
			continue;
		}

		const declarations = html.slice(open + 1, close);
		if (/background(-color)?\s*:/i.test(declarations)) {
			// The selector runs from the previous brace to this one, bounded so a document with
			// no braces at all cannot make this scan quadratic.
			const previousBrace = Math.max(html.lastIndexOf("{", open - 1), html.lastIndexOf("}", open - 1)) + 1;
			let selectorText = html.slice(Math.max(previousBrace, open - 200), open);
			// Cut at the last `>`. It does two jobs: it drops the markup before an inline
			// `<style>` (otherwise the "selector" for the first rule is the whole document
			// prefix), and it drops the left side of a child combinator, so `body > main`
			// correctly does NOT count as painting the canvas while `html > body` does.
			const lastAngle = selectorText.lastIndexOf(">");
			if (lastAngle !== -1) selectorText = selectorText.slice(lastAngle + 1);
			const selectors = selectorText.split(",");
			for (const selector of selectors) {
				// A canvas selector is `html` or `body` plus optional class, id, pseudo or
				// attribute — and nothing else. A space or combinator means it is targeting a
				// descendant, which is not the canvas.
				if (/^\s*(html|body)[.#:[][^\s>+~]*\s*$|^\s*(html|body)\s*$/i.test(selector)) return true;
			}
		}
		cursor = close + 1;
	}
	return false;
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
