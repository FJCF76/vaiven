// Seeding state from the values the author wrote into the markup.
//
// Without this, the first edit to a freshly published form reads as `"" -> "900"` rather
// than `"18400" -> "900"`, because the document's state was empty while the HTML carried
// the starting values. Telling authors to duplicate every default into `state` would work
// and is exactly the discipline §7 says the design must not rely on ("the separation does
// not rely on Claude behaving"). The server already parses the content on publish, so it
// reads the defaults itself.
//
// Only keys the state does not already have are seeded: stored state always wins, which is
// what makes republishing safe.

export async function seedStateFromContent(
	html: string,
	current: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const found: Record<string, unknown> = {};

	let pendingTextarea: string | null = null;
	let textareaValue = "";

	const rewriter = new HTMLRewriter()
		.on("input", {
			element(element) {
				const name = element.getAttribute("name");
				if (!name) return;
				const type = (element.getAttribute("type") ?? "text").toLowerCase();

				// A10: these never enter the document, here as much as in the helper.
				if (type === "password" || type === "file" || type === "hidden") return;

				if (type === "checkbox") {
					found[name] = element.hasAttribute("checked");
					return;
				}
				if (type === "radio") {
					if (element.hasAttribute("checked")) found[name] = element.getAttribute("value") ?? "";
					else if (!(name in found)) found[name] = "";
					return;
				}
				found[name] = element.getAttribute("value") ?? "";
			},
		})
		.on("textarea", {
			element(element) {
				const name = element.getAttribute("name");
				pendingTextarea = name;
				textareaValue = "";
				if (name) {
					element.onEndTag(() => {
						if (pendingTextarea) found[pendingTextarea] = textareaValue;
						pendingTextarea = null;
					});
				}
			},
			text(chunk) {
				if (pendingTextarea) textareaValue += chunk.text;
			},
		});

	await rewriter.transform(new Response(html)).text();

	const seeded = { ...current };
	for (const [key, value] of Object.entries(found)) {
		if (!(key in seeded)) seeded[key] = value;
	}
	return seeded;
}
