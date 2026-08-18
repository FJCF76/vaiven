// The write pipeline, as a state machine with no DOM in it.
//
// A7: debounce, version pinning, single-flight, retry, conflict merge and the circuit
// breaker are one component. Specified across five bullets and written last, in browser
// code, they become the least testable and most load-bearing thing in the system. So the
// clock, the transport and the notifications are injected and this file is unit-tested
// headlessly.
//
// The bug this exists to prevent: the 3 s poll refreshes the version the shell holds, so a
// PUT would send the LATEST version carrying state derived from an OLDER one. The
// compare-and-set then succeeds and silently overwrites whatever the other writer just did
// — If-Match becomes decorative and the 409 path never fires in the case it exists for.

export type WriterStatus =
	| { kind: "clean"; at?: number }
	| { kind: "dirty" }
	| { kind: "saving" }
	| { kind: "retrying"; attempt: number }
	| { kind: "blocked"; reason: string }
	| { kind: "readonly" };

export interface PutOutcome {
	ok: boolean;
	/** New version on success. */
	version?: number;
	/** Present on 409. */
	conflict?: { version: number; state: unknown };
	/** Anything else: 401, 413, 507, network failure. `fatal` stops the pipeline. */
	error?: { code: string; message: string; fatal: boolean };
}

export interface WriterDeps {
	now(): number;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
	put(input: { state: unknown; events: unknown[]; ifMatch: number; requestId: string }): Promise<PutOutcome>;
	onStatus(status: WriterStatus): void;
	/** Three-way merge. Returns the state to send next, or null to accept theirs. */
	merge(base: unknown, ours: unknown, theirs: unknown): unknown | null;
	/** Called when the server's state should replace what is on screen. */
	onAdopt(state: unknown, version: number): void;
	randomId(): string;
}

const DEBOUNCE_MS = 400;
/** A7: without a ceiling, continuous typing or a slider drag restarts the trailing timer
 *  forever and nothing is ever written. */
const MAX_WAIT_MS = 2_000;
const RETRY_BACKOFF_MS = [500, 1_500, 4_000];
/** Circuit breaker: a render/mutate loop otherwise writes every debounce interval forever. */
const BREAKER_WRITES = 20;
const BREAKER_WINDOW_MS = 10_000;

export class Writer {
	/** The version the PENDING state was derived from. Never updated by the poll — that
	 *  is the entire point. */
	private baseVersion = 0;
	/** The newest version the poll has seen. */
	private serverVersion = 0;
	/** The last state we know the server has. */
	private baseState: unknown = {};

	private pendingState: unknown = null;
	private pendingEvents: unknown[] = [];
	private inFlight = false;
	private stopped = false;
	private readonly_ = false;

	private debounceTimer: unknown = null;
	private maxWaitAt = 0;
	private attempt = 0;
	/** A7: one idempotency key per batch, held across retries. Cleared on success or rebase. */
	private batchId: string | null = null;
	private writeTimes: number[] = [];

	constructor(private readonly deps: WriterDeps) {}

	/** From `init`, or from a poll that found no local edits pending. */
	adopt(state: unknown, version: number): void {
		this.baseState = state;
		this.baseVersion = version;
		this.serverVersion = version;
		this.pendingState = null;
		this.pendingEvents = [];
		this.deps.onAdopt(state, version);
		this.status({ kind: this.readonly_ ? "readonly" : "clean", at: this.deps.now() });
	}

	setReadonly(readonly: boolean): void {
		this.readonly_ = readonly;
		if (readonly) this.status({ kind: "readonly" });
	}

	/** The poll observed a version. */
	observeServer(version: number, state: unknown): void {
		if (version <= this.serverVersion) return;
		this.serverVersion = version;

		if (this.pendingState === null && !this.inFlight) {
			// Nothing local at risk — take theirs.
			this.adopt(state, version);
			return;
		}
		// Someone else moved while we hold unsent edits. That is a conflict BEFORE the
		// PUT, and racing to send would clobber them.
		this.reconcile(state, version);
	}

	/** The document changed locally. */
	localChange(state: unknown, events: unknown[] = []): void {
		if (this.readonly_ || this.stopped) return;

		this.pendingState = state;
		if (events.length) this.pendingEvents.push(...events);
		this.status({ kind: "dirty" });

		const now = this.deps.now();
		if (this.maxWaitAt === 0) this.maxWaitAt = now + MAX_WAIT_MS;

		if (this.debounceTimer !== null) this.deps.clearTimer(this.debounceTimer);
		const wait = Math.max(0, Math.min(DEBOUNCE_MS, this.maxWaitAt - now));
		this.debounceTimer = this.deps.setTimer(() => this.flush("debounce"), wait);
	}

	/** Unload, explicit save, or "Done for now". A7: a hidden tab must still flush — only
	 *  the POLL pauses on visibility, never the write pipeline. */
	flush(_reason: string): void {
		if (this.debounceTimer !== null) {
			this.deps.clearTimer(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.maxWaitAt = 0;
		void this.send();
	}

	private status(status: WriterStatus): void {
		this.deps.onStatus(status);
	}

	private breakerTripped(): boolean {
		const now = this.deps.now();
		this.writeTimes = this.writeTimes.filter((t) => now - t < BREAKER_WINDOW_MS);
		return this.writeTimes.length >= BREAKER_WRITES;
	}

	private async send(): Promise<void> {
		if (this.stopped || this.readonly_) return;
		// A7: strictly serialized. A change arriving mid-flight cannot know the next
		// version, so it waits and is folded into the following batch.
		if (this.inFlight) return;
		if (this.pendingState === null) return;

		if (this.breakerTripped()) {
			this.stopped = true;
			this.status({
				kind: "blocked",
				reason: "This document is saving in a loop, so saving has been paused. It usually means the app calls Vaiven.mutate() from inside Vaiven.render().",
			});
			return;
		}

		this.inFlight = true;
		this.writeTimes.push(this.deps.now());
		this.status({ kind: "saving" });

		const state = this.pendingState;
		const events = this.pendingEvents;
		// A7: an idempotency key, so a timeout where the server DID commit does not come
		// back as a 409 whose recovery path discards edits that were actually saved.
		//
		// Minted once per BATCH, not per attempt. It used to be generated here, inside the
		// function the retry timer re-enters, so every retry carried a fresh id, the
		// server's replay check could never match, and the annotations from the attempt
		// that HAD committed were inserted a second time — someone who pressed "Done for
		// now" during a flaky moment recorded as done twice, which is the exact thing the
		// key exists to prevent.
		this.batchId ??= this.deps.randomId();
		const requestId = this.batchId;

		const outcome = await this.deps.put({ state, events, ifMatch: this.baseVersion, requestId });

		this.inFlight = false;

		if (outcome.ok && outcome.version !== undefined) {
			this.attempt = 0;
			this.batchId = null;
			// Only clear what we actually sent; anything typed meanwhile stays pending.
			if (this.pendingState === state) {
				this.pendingState = null;
				this.pendingEvents = [];
			} else {
				this.pendingEvents = this.pendingEvents.slice(events.length);
			}
			this.baseState = state;
			this.baseVersion = outcome.version;
			this.serverVersion = Math.max(this.serverVersion, outcome.version);
			this.status(
				this.pendingState === null
					? { kind: "clean", at: this.deps.now() }
					: { kind: "dirty" },
			);
			if (this.pendingState !== null) void this.send();
			return;
		}

		if (outcome.conflict) {
			// A merge produces a genuinely different write, so it gets a new key.
			this.batchId = null;
			this.reconcile(outcome.conflict.state, outcome.conflict.version);
			return;
		}

		const error = outcome.error ?? { code: "unknown", message: "Save failed.", fatal: false };
		if (error.fatal) {
			this.stopped = true;
			this.status({ kind: "blocked", reason: error.message });
			return;
		}

		// Transient: back off and try again. The pending state is still pending, so
		// nothing is lost by waiting.
		const delay = RETRY_BACKOFF_MS[Math.min(this.attempt, RETRY_BACKOFF_MS.length - 1)]!;
		this.attempt++;
		this.status({ kind: "retrying", attempt: this.attempt });
		this.deps.setTimer(() => void this.send(), delay);
	}

	/**
	 * A7: a 409 is a MERGE, not a replacement.
	 *
	 * "Restore server state, repaint, and warn" means overwriting the field someone is
	 * typing into, mid-sentence, with no way back. The merge keeps ours where they
	 * differ from base, and the caller stashes the losing side so "keep my version" is
	 * never a lie.
	 */
	private reconcile(theirs: unknown, theirVersion: number): void {
		const ours = this.pendingState;
		this.serverVersion = Math.max(this.serverVersion, theirVersion);

		if (ours === null) {
			this.adopt(theirs, theirVersion);
			return;
		}

		const merged = this.deps.merge(this.baseState, ours, theirs);

		if (merged === null) {
			// Caller decided to take theirs.
			this.adopt(theirs, theirVersion);
			return;
		}

		// Re-base onto their version and send the merge.
		this.baseState = theirs;
		this.baseVersion = theirVersion;
		this.pendingState = merged;
		this.status({ kind: "dirty" });
		void this.send();
	}

	/** Test and shutdown seam. */
	snapshot() {
		return {
			baseVersion: this.baseVersion,
			serverVersion: this.serverVersion,
			pending: this.pendingState !== null,
			inFlight: this.inFlight,
			stopped: this.stopped,
		};
	}
}

/**
 * Field-level three-way merge.
 *
 * Ours wins where we changed it; theirs applies everywhere else. That is what makes a
 * remote write land without eating the sentence someone is in the middle of typing.
 */
export function threeWayMerge(base: unknown, ours: unknown, theirs: unknown): unknown {
	if (!isObject(base) || !isObject(ours) || !isObject(theirs)) {
		return ours;
	}

	const merged: Record<string, unknown> = { ...(theirs as Record<string, unknown>) };
	const baseObj = base as Record<string, unknown>;
	const oursObj = ours as Record<string, unknown>;

	const theirsObj = theirs as Record<string, unknown>;

	for (const key of Object.keys(oursObj)) {
		const changedByUs = JSON.stringify(oursObj[key]) !== JSON.stringify(baseObj[key]);
		if (!changedByUs) continue;

		// Recurse into nested objects instead of overwriting them whole. A flat assignment
		// here loses every sibling field the other writer changed: we edit `contact.email`,
		// they edit `contact.phone`, and their phone number disappears at the moment the
		// merge is supposed to be saving it. Nesting is the normal shape for anything more
		// structured than a form, so this was not an edge case.
		if (isObject(baseObj[key]) && isObject(oursObj[key]) && isObject(theirsObj[key])) {
			merged[key] = threeWayMerge(baseObj[key], oursObj[key], theirsObj[key]);
			continue;
		}

		merged[key] = oursObj[key];
	}

	// A key we deleted stays deleted, INCLUDING when they edited it meanwhile.
	//
	// It used to stay deleted only if their copy still matched the base, so a delete
	// racing an edit silently resurrected the thing the person had just removed — and the
	// status went straight to "Saved", so nothing said otherwise. Delete-vs-edit is a
	// genuine conflict and somebody's work is lost either way; the field-level policy
	// this merge is built on is that ours wins where we changed it, and a deletion is a
	// change. The other side is an agent that can re-add; the person watching the screen
	// cannot un-see their deletion undoing itself.
	for (const key of Object.keys(baseObj)) {
		if (!(key in oursObj)) delete merged[key];
	}

	return merged;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
