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
	code: "added_doctype" | "stripped_meta_csp" | "stripped_base";
	message: string;
}

const DOCTYPE_AT_START = /^\s*<!doctype\b[^>]*>/i;
const HAS_HEAD = /<head[\s>]/i;

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

	if (!HAS_HEAD.test(html)) {
		// Case 2. Splice a head in after the doctype so the helper still runs first,
		// with the doctype left exactly where it has to be.
		const match = html.match(DOCTYPE_AT_START)!;
		const doctype = match[0];
		const rest = html.slice(doctype.length);
		return { html: `${doctype}\n<head>${scriptTag(helper)}</head>${rest}`, warnings };
	}

	// Case 1.
	const rewritten = await new HTMLRewriter()
		.on("head", {
			element(element) {
				element.prepend(scriptTag(helper), { html: true });
			},
		})
		.transform(new Response(html))
		.text();

	return { html: rewritten, warnings };
}
