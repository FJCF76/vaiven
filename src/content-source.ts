// Where `/c/:id` gets its HTML.
//
// Documents come from the database. The three fixtures stay reachable because the Phase 0
// gates run against the live deployment and need something inert to point at — they carry
// no data and depend on nothing.

import type { Database } from "bun:sqlite";
import { join } from "node:path";

const FIXTURE_ROOT = join(import.meta.dir, "..", "test", "fixtures");

const FIXTURES: Record<string, string> = {
	probe: "probe.html", // gate 1: opaque origin
	canary: "canary.html", // gate 4: the authoring ceiling
	fields: "fields.html", // A10: automatic-mode field coverage
};

export interface ContentResult {
	html: string;
	contentVersion: number;
}

export async function lookup(db: Database | null, id: string): Promise<ContentResult | null> {
	const fixture = FIXTURES[id];
	if (fixture) {
		const file = Bun.file(join(FIXTURE_ROOT, fixture));
		if (await file.exists()) return { html: await file.text(), contentVersion: 0 };
		return null;
	}

	if (!db) return null;

	const row = db
		.query<{ content: string; content_version: number }, [string]>(
			"SELECT content, content_version FROM doc_content WHERE doc_id = ?",
		)
		.get(id);

	if (!row || !row.content) return null;
	return { html: row.content, contentVersion: row.content_version };
}
