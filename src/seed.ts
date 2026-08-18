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

/** Merge extracted defaults into state. Sync, so it can run inside a transaction. */
export function seedStateFromContentSync(
	current: Record<string, unknown>,
	found: Record<string, unknown>,
): Record<string, unknown> {
	const seeded = { ...current };
	for (const [key, value] of Object.entries(found)) {
		if (!(key in seeded)) seeded[key] = value;
	}
	return seeded;
}

/**
 * Parse the markup for authored default values. Async, so it runs before the write.
 *
 * The exclusions here must match the helper's exactly. They did not, and the consequence
 * was worse than a missing field: seeding captured values the helper then refused to
 * report, so the very first edit recorded them as `from: "<the value>"` in the event log —
 * which is readable from a bearer URL. An opt-out that holds in the browser and not on the
 * server is not an opt-out.
 */
export async function extractSeedFields(html: string): Promise<Record<string, unknown>> {
	const found: Record<string, unknown> = {};

	let pendingTextarea: string | null = null;
	let textareaValue = "";
	let pendingSelect: string | null = null;
	let selectMultiple = false;
	/** Values of options carrying `selected`. */
	let chosen: string[] = [];
	/** The first option, which is what a single select shows when nothing is selected. */
	let firstOption: string | null = null;
	let pendingEditable: string | null = null;
	let editableText = "";
	let readingOptionText = false;
	let optionText = "";
	// Depth of open `data-vaiven-ignore` subtrees. Anything inside one is not ours to read.
	let ignoreDepth = 0;

	/** The helper's rule, restated: never capture what cannot be safely republished. */
	const excluded = (element: { getAttribute(name: string): string | null; hasAttribute(name: string): boolean }): boolean => {
		if (ignoreDepth > 0) return true;
		if (element.hasAttribute("disabled")) return true;
		if (element.hasAttribute("data-vaiven-ignore")) return true;
		const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase();
		return autocomplete === "off" || autocomplete.startsWith("cc-") || autocomplete.includes("password");
	};

	const rewriter = new HTMLRewriter()
		.on("[data-vaiven-ignore]", {
			element(element) {
				try {
					element.onEndTag(() => {
						ignoreDepth = Math.max(0, ignoreDepth - 1);
					});
					ignoreDepth++;
				} catch {
					// A void element (`<input data-vaiven-ignore>`) has no end tag and so
					// opens no subtree. The attribute still excludes the element itself,
					// which `excluded()` checks directly.
				}
			},
		})
		.on("input", {
			element(element) {
				const name = element.getAttribute("name");
				if (!name) return;
				const type = (element.getAttribute("type") ?? "text").toLowerCase();

				// A10: these never enter the document, here as much as in the helper.
				if (type === "password" || type === "file" || type === "hidden") return;
				if (excluded(element)) return;

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
		// The living-document case: a named contenteditable region. Its authored content is
		// its default value, exactly like a textarea's.
		.on("[contenteditable][name]", {
			element(element) {
				if (element.getAttribute("contenteditable") === "false") return;
				const name = element.getAttribute("name");
				pendingEditable = excluded(element) ? null : name;
				editableText = "";
				if (pendingEditable) {
					const key = pendingEditable;
					element.onEndTag(() => {
						found[key] = editableText.trim();
						pendingEditable = null;
					});
				}
			},
			text(chunk) {
				if (pendingEditable) editableText += chunk.text;
			},
		})
		.on("textarea", {
			element(element) {
				const name = element.getAttribute("name");
				pendingTextarea = excluded(element) ? null : name;
				textareaValue = "";
				if (pendingTextarea) {
					element.onEndTag(() => {
						if (pendingTextarea) found[pendingTextarea] = textareaValue;
						pendingTextarea = null;
					});
				}
			},
			text(chunk) {
				if (pendingTextarea) textareaValue += chunk.text;
			},
		})
		// A select's authored default is whichever option carries `selected`, and if none
		// does the browser picks the first — so a document seeded without this reported the
		// user's first interaction as a change from nothing.
		// A select's authored default is whichever option carries `selected`, and when none
		// does the browser shows the first — so a document seeded without this reported the
		// person's first interaction as a change from nothing.
		.on("select", {
			element(element) {
				const name = element.getAttribute("name");
				pendingSelect = excluded(element) ? null : name;
				selectMultiple = element.hasAttribute("multiple");
				chosen = [];
				firstOption = null;
				if (!pendingSelect) return;

				const key = pendingSelect;
				const multiple = selectMultiple;
				element.onEndTag(() => {
					found[key] = multiple ? [...chosen] : (chosen[0] ?? firstOption ?? "");
					pendingSelect = null;
				});
			},
		})
		.on("option", {
			element(element) {
				if (!pendingSelect) return;
				const explicit = element.getAttribute("value");
				const selected = element.hasAttribute("selected");

				// An option with no `value` attribute submits its own text, so the text has
				// to be collected rather than assumed empty.
				if (explicit === null) {
					readingOptionText = true;
					optionText = "";
					element.onEndTag(() => {
						const text = optionText.trim();
						if (selected) chosen.push(text);
						else if (firstOption === null) firstOption = text;
						readingOptionText = false;
					});
					return;
				}

				if (selected) chosen.push(explicit);
				else if (firstOption === null) firstOption = explicit;
			},
			text(chunk) {
				if (readingOptionText) optionText += chunk.text;
			},
		});

	await rewriter.transform(new Response(html)).text();
	return found;
}

/** Convenience for the create path, which has no transaction to stay out of. */
export async function seedStateFromContent(
	html: string,
	current: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return seedStateFromContentSync(current, await extractSeedFields(html));
}
