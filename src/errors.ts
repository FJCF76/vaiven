// A9: no error without a remedy.
//
// The build rule mirrors §9's "nothing is ever truncated silently". An error that states a
// fact and stops sends the agent back to guess. The 409 on PUT /state already did this
// right by returning the state to merge; every other path matches it now.
//
// Five of these codes did not exist in §6 and are the ones that will actually occur:
// `invalid` (a hand-built curl with malformed JSON), `revoked` as distinct from
// `unauthorized`, `read_only` (a read key writing — reported as `unauthorized`, it sends
// the agent to re-check a key that is fine), `disabled`, and `precondition_required`.

import { baseHeaders } from "./headers.ts";

export type ErrorCode =
	| "unauthorized"
	| "revoked"
	| "read_only"
	| "disabled"
	| "not_found"
	| "conflict"
	| "precondition_required"
	| "invalid"
	| "too_large"
	| "quota_exceeded"
	| "rate_limited"
	| "upstream_error";

const STATUS: Record<ErrorCode, number> = {
	unauthorized: 401,
	revoked: 401,
	read_only: 403,
	disabled: 403,
	not_found: 404,
	conflict: 409,
	precondition_required: 428,
	invalid: 400,
	// A9: 402 Payment Required is wrong on a system with no billing, and would confuse
	// agents and proxies alike. 507 says what is true: the store cannot accept it.
	quota_exceeded: 507,
	too_large: 413,
	rate_limited: 429,
	upstream_error: 502,
};

/** Which sub-page of the manual explains this class of failure (A12). */
const GUIDE_SECTION: Record<ErrorCode, string> = {
	unauthorized: "errors",
	revoked: "errors",
	read_only: "errors",
	disabled: "errors",
	not_found: "errors",
	conflict: "errors",
	precondition_required: "errors",
	invalid: "errors",
	too_large: "limits",
	quota_exceeded: "limits",
	rate_limited: "limits",
	upstream_error: "errors",
};

export interface ErrorDetail {
	/** What to do next. Mandatory: this field is the whole point of the shape. */
	hint: string;
	limit?: number;
	actual?: number;
	field?: string;
	/** Extra top-level keys merged into the body — the 409's `{version, state}`. */
	extra?: Record<string, unknown>;
	headers?: Record<string, string>;
}

export class ApiError extends Error {
	constructor(
		readonly code: ErrorCode,
		message: string,
		readonly detail: ErrorDetail,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export function fail(code: ErrorCode, message: string, detail: ErrorDetail): never {
	throw new ApiError(code, message, detail);
}

export function errorResponse(error: ApiError, appOrigin: string): Response {
	const { hint, limit, actual, field, extra, headers } = error.detail;

	const body = {
		error: {
			code: error.code,
			message: error.message,
			hint,
			...(limit !== undefined ? { limit } : {}),
			...(actual !== undefined ? { actual } : {}),
			...(field !== undefined ? { field } : {}),
			// A12: the manual travels with the failure, where it is needed, not only on
			// the success path where it is not.
			guide: `${appOrigin}/guide/${GUIDE_SECTION[error.code]}.md`,
		},
		...(extra ?? {}),
	};

	return new Response(JSON.stringify(body, null, 2), {
		status: STATUS[error.code],
		headers: {
			...baseHeaders(),
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...(headers ?? {}),
		},
	});
}
