// Deriving the event log from state, and clamping everything that a person wrote.
//
// DEVIATION FROM A1, deliberate, and it makes the design smaller.
//
// A1 had the shell compute `from`/`to` with a shadow-value cache invalidated on five
// separate paths, and warned that missing one invalidation corrupts the product's core
// output with no test noticing. It also inherited eng finding H16: in app mode the events
// were supplied by the content's own JavaScript, so Claude-authored code decided what the
// log said about a human, and a buggy or hostile app could fabricate or omit entries.
//
// Both problems disappear if the SERVER derives the events. It holds the previous state
// and the new one on every write, so `from` is simply the stored value — authoritative,
// impossible to forge, and needing no cooperation from the page. Coalescing then falls out
// of debouncing the write rather than being a second mechanism that has to agree with it.
//
// The client may still send ANNOTATIONS — `done`, `note`, `error` — because those carry
// intent the server cannot observe. They are marked as such and clamped.

import { LIMITS } from "./quota.ts";

export interface DerivedEvent {
	kind: "edit";
	field: string;
	from?: string;
	to?: string;
	op?: "add" | "remove";
	item?: string;
}

export interface Annotation {
	kind: string;
	note?: string;
	payload?: unknown;
}

/** A11: every string that came from a person is clamped before it can reach an agent's
 *  context. The 200-character rule was written for context economy; it works just as well
 *  as a containment control, and it applies to ALL strings, not only large ones. */
export const CLAMP = 200;

export function clamp(value: unknown, limit = CLAMP): string {
	const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
	if (text.length <= limit) return text;
	return `${text.slice(0, limit - 1)}…`;
}

// --------------------------------------------------------------------- element identity

/**
 * A1: arrays are aligned by identity, not index.
 *
 * Index-keyed diffing turns one insertion into N events and pairs `from` and `to` values
 * that belong to different objects. `deliverables[2].days` is also unreadable to anyone
 * looking a day later.
 *
 * The id is stamped SERVER-side on write, so it needs nothing from the author or the
 * helper. Content already must never assume a field exists, which is what makes this safe.
 */
export const VID = "_vid";

let vidCounter = 0;

function newVid(): string {
	vidCounter = (vidCounter + 1) % 1_000_000;
	return `v${Date.now().toString(36)}${vidCounter.toString(36)}`;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** First write: nothing to inherit from, so every element gets a fresh identity. */
export function stampVids(value: unknown): unknown {
	return reconcileVids(undefined, value);
}

/**
 * Give every array element an identity, INHERITING it from the previous state wherever
 * possible.
 *
 * Minting ids on the incoming state alone does not work, and the failure is loud: an API
 * client does not echo `_vid`, so freshly minted ids match nothing in the stored state and
 * every element reads as an addition plus a removal. Caught end to end, missed by unit
 * tests because those pre-stamped both sides.
 *
 * Two passes, in priority order:
 *   1. An echoed `_vid` that exists in the previous state wins. The shell renders from the
 *      state it was given, so it echoes them, and identity then survives reordering.
 *   2. Anything else inherits positionally from the leftover previous elements. That is
 *      what an index diff would have done, but only as a fallback, and it still yields
 *      field-level events instead of add/remove churn. Appending a row — the common case
 *      for a raw API client — produces exactly one `add`.
 */
export function reconcileVids(previous: unknown, next: unknown): unknown {
	if (Array.isArray(next)) {
		const before = Array.isArray(previous) ? previous : [];

		const byId = new Map<string, unknown>();
		for (const element of before) {
			if (isPlainObject(element) && typeof element[VID] === "string") {
				byId.set(element[VID] as string, element);
			}
		}

		const claimed = new Set<string>();
		const out: unknown[] = new Array(next.length);
		const unresolved: number[] = [];

		for (let index = 0; index < next.length; index++) {
			const element = next[index];
			const vid = isPlainObject(element) && typeof element[VID] === "string" ? (element[VID] as string) : null;

			if (vid && byId.has(vid) && !claimed.has(vid)) {
				claimed.add(vid);
				out[index] = reconcileVids(byId.get(vid), element);
			} else {
				unresolved.push(index);
			}
		}

		const leftovers = before.filter(
			(element) => !(isPlainObject(element) && typeof element[VID] === "string" && claimed.has(element[VID] as string)),
		);

		let cursor = 0;
		for (const index of unresolved) {
			const element = next[index];
			const source = leftovers[cursor++];

			if (!isPlainObject(element)) {
				out[index] = reconcileVids(source, element);
				continue;
			}

			const merged = reconcileVids(source, element) as Record<string, unknown>;
			const carried = typeof merged[VID] === "string" ? (merged[VID] as string) : null;

			// A client can echo the same id twice — by duplicating a row, or maliciously.
			// Letting both keep it makes the alignment map collide, after which two rows
			// diff against one previous element and edits land on the wrong row.
			if (carried === null || claimed.has(carried)) {
				const inherited =
					isPlainObject(source) && typeof source[VID] === "string" ? (source[VID] as string) : null;
				merged[VID] = inherited && !claimed.has(inherited) ? inherited : newVid();
			}
			claimed.add(merged[VID] as string);
			out[index] = merged;
		}

		return out;
	}

	if (isPlainObject(next)) {
		const before = isPlainObject(previous) ? previous : {};
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(next)) out[key] = reconcileVids(before[key], value);
		return out;
	}

	return next;
}

/** The element's first string-valued property, so an event reads the way a person would
 *  describe it: "Extra budget", not "[2]". */
function labelOf(element: unknown, fallback: string): string {
	if (isPlainObject(element)) {
		for (const [key, value] of Object.entries(element)) {
			if (key === VID) continue;
			if (typeof value === "string" && value.trim()) return clamp(value.trim(), 40);
		}
	}
	return fallback;
}

// -------------------------------------------------------------------------- the differ

/** Above this many element-level events for one array, emit a single summary instead. */
export const COLLAPSE_AT = 10;

function scalarString(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	return JSON.stringify(value) ?? "";
}

/** Multiset comparison: what left, what arrived, ignoring order. */
function diffScalarArray(path: string, before: unknown[], after: unknown[], out: DerivedEvent[]): void {
	const counts = new Map<string, number>();
	for (const value of before) counts.set(scalarString(value), (counts.get(scalarString(value)) ?? 0) + 1);
	for (const value of after) {
		const key = scalarString(value);
		const remaining = counts.get(key) ?? 0;
		counts.set(key, remaining - 1);
	}

	const local: DerivedEvent[] = [];
	for (const [value, count] of counts) {
		for (let i = 0; i < count; i++) local.push({ kind: "edit", field: path, op: "remove", item: clamp(value, 40) });
		for (let i = 0; i < -count; i++) local.push({ kind: "edit", field: path, op: "add", item: clamp(value, 40) });
	}

	if (local.length === 0) return;
	if (local.length > COLLAPSE_AT) {
		out.push({
			kind: "edit",
			field: path,
			from: `${before.length} items`,
			to: `${after.length} items`,
			item: `${local.length} changed`,
		});
		return;
	}
	out.push(...local);
}

function diffArray(path: string, before: unknown[], after: unknown[], out: DerivedEvent[]): void {
	const beforeById = new Map<string, Record<string, unknown>>();
	for (const element of before) {
		if (isPlainObject(element) && typeof element[VID] === "string") {
			beforeById.set(element[VID] as string, element);
		}
	}

	// Arrays of plain values — tags, a multi-select, a checklist of strings — carry no
	// identity to align on, so the object path below skips them entirely and the change
	// is invisible in the log. Compare them as a multiset instead.
	const identifiable = (value: unknown) => isPlainObject(value) && typeof value[VID] === "string";
	if (!before.some(identifiable) && !after.some(identifiable)) {
		diffScalarArray(path, before, after, out);
		return;
	}

	const afterIds = new Set<string>();
	const local: DerivedEvent[] = [];

	for (const element of after) {
		if (!isPlainObject(element) || typeof element[VID] !== "string") continue;
		const vid = element[VID] as string;
		afterIds.add(vid);

		const previous = beforeById.get(vid);
		if (!previous) {
			local.push({ kind: "edit", field: path, op: "add", item: labelOf(element, "an item") });
			continue;
		}

		// Same element, possibly changed contents. Name it by its label so the event
		// survives reordering and reads as a sentence.
		const label = labelOf(previous, labelOf(element, "an item"));
		for (const key of new Set([...Object.keys(previous), ...Object.keys(element)])) {
			if (key === VID) continue;
			const from = scalarString(previous[key]);
			const to = scalarString(element[key]);
			if (from !== to) {
				local.push({ kind: "edit", field: `${path}[${label}].${key}`, from: clamp(from), to: clamp(to) });
			}
		}
	}

	for (const [vid, element] of beforeById) {
		if (!afterIds.has(vid)) {
			local.push({ kind: "edit", field: path, op: "remove", item: labelOf(element, "an item") });
		}
	}

	// Reordering with no content change produces nothing, which is correct: it is not
	// something anyone reads a log to find out.
	if (local.length === 0) return;

	if (local.length > COLLAPSE_AT) {
		out.push({
			kind: "edit",
			field: path,
			from: `${before.length} items`,
			to: `${after.length} items`,
			item: `${local.length} rows changed`,
		});
		return;
	}

	out.push(...local);
}

function diffValue(path: string, before: unknown, after: unknown, out: DerivedEvent[]): void {
	if (Array.isArray(before) && Array.isArray(after)) {
		diffArray(path, before, after, out);
		return;
	}

	if (isPlainObject(before) && isPlainObject(after)) {
		for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
			if (key === VID) continue;
			diffValue(path ? `${path}.${key}` : key, before[key], after[key], out);
		}
		return;
	}

	const from = scalarString(before);
	const to = scalarString(after);
	if (from === to) return;

	// A1: never emit a contentless event. E2's harness produced `{from:"", to:"line
	// edited"}` five times in ten, and an event that does not say what changed costs
	// context and pays nothing.
	out.push({ kind: "edit", field: path || "state", from: clamp(from), to: clamp(to) });
}

/**
 * The authoritative diff. Everything in the returned list is something the server itself
 * observed changing between two stored states.
 */
export function deriveEvents(before: unknown, after: unknown): DerivedEvent[] {
	const out: DerivedEvent[] = [];
	diffValue("", before ?? {}, after ?? {}, out);

	if (out.length <= LIMITS.eventsPerWrite) return out;

	// "Nothing is ever truncated silently" applies to the log too. A history that just
	// stops mid-way, with nothing saying so, is worse than one that admits the gap.
	const kept = out.slice(0, LIMITS.eventsPerWrite - 1);
	kept.push({
		kind: "edit",
		field: "state",
		item: `${out.length - kept.length} further changes were not itemised`,
		from: `${out.length} changes`,
		to: `${kept.length} recorded`,
	});
	return kept;
}

// ------------------------------------------------------------------------ annotations

/** Kinds a client may assert, because they carry intent the server cannot observe.
 *  `edit` is deliberately absent: it is derived, never accepted. */
const ANNOTATION_KINDS = new Set(["done", "note", "error", "conflict", "webhook_failed"]);

export function validateAnnotations(input: unknown): Annotation[] {
	if (!Array.isArray(input)) return [];

	const out: Annotation[] = [];
	for (const raw of input.slice(0, LIMITS.eventsPerWrite)) {
		if (!isPlainObject(raw)) continue;
		const kind = typeof raw.kind === "string" ? raw.kind : "note";
		if (!ANNOTATION_KINDS.has(kind)) continue;

		out.push({
			kind,
			...(raw.note !== undefined ? { note: clamp(raw.note, 500) } : {}),
			...(raw.payload !== undefined ? { payload: clamp(raw.payload, LIMITS.eventBytes) } : {}),
		});
	}
	return out;
}

// ------------------------------------------------------------------ safe JSON parsing

/**
 * A11: null-prototype everything, and refuse the keys that turn a data structure into a
 * behaviour change. `__proto__` in stored state is inert as text but not inert once the
 * shell merges it.
 */
export function safeParse(text: string): unknown {
	return JSON.parse(text, function reviver(key, value) {
		// Only __proto__ actually reassigns a prototype through JSON.parse. Dropping keys
		// named `constructor` or `prototype` as well would silently discard a form field
		// that a person legitimately named that, and every object here is null-prototype
		// anyway, so neither is reachable as a behaviour.
		if (key === "__proto__") return undefined;
		if (isPlainObject(value)) return Object.assign(Object.create(null), value);
		return value;
	});
}

// ------------------------------------------------------------------- field warnings

/**
 * A3: a field with no `name` is stored under a structural path prefixed with `~`, and the
 * agent has to be told — otherwise it reads a key like `~div:nth-child(2)>input:nth-child(1)`
 * and has to guess whether that is a bug, a convention, or something it wrote itself.
 *
 * Computed at write time and stored, because the alternative is scanning up to a megabyte
 * of JSON on a route that answers 600 times a minute.
 */
export function fieldWarnings(state: unknown): { code: string; message: string; paths: string[] }[] {
	if (!isPlainObject(state)) return [];
	const paths = Object.keys(state).filter((key) => key.startsWith("~"));
	if (paths.length === 0) return [];

	return [
		{
			code: "unnamed_fields",
			message:
				"Some fields have no `name` attribute, so their values are stored under a structural path starting with `~`. Those paths change if you edit the markup around them, and the stored value is then stranded under the old key. Add a `name` to every field you want to read back.",
			paths: paths.slice(0, 20),
		},
	];
}
