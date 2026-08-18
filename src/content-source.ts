// Where `/c/:id` gets its HTML.
//
// Phase 0 serves fixtures so the sandbox gates can be proved against a real host before
// any database exists. Phase 2 replaces `lookup` with the `doc_content` read; nothing
// else in the request path changes, which is the point of keeping it behind one function.

import { join } from "node:path";

const FIXTURE_ROOT = join(import.meta.dir, "..", "test", "fixtures");

/** Fixture ids that exist only to prove Phase 0's gates. Removed once Phase 2 lands. */
const FIXTURES: Record<string, string> = {
	// Reports its own origin and whether storage throws — the opaque-origin gate.
	probe: "probe.html",
	// Exercises every capability A4 says is allowed — the ceiling gate.
	canary: "canary.html",
	// Automatic-mode field coverage (A10). Used from Phase 4 onward.
	fields: "fields.html",
};

export async function lookup(id: string): Promise<string | null> {
	const fixture = FIXTURES[id];
	if (!fixture) return null;

	const file = Bun.file(join(FIXTURE_ROOT, fixture));
	if (!(await file.exists())) return null;
	return file.text();
}
