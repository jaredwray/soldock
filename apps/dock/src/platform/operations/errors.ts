import { ERRORS, type ErrorCode } from "@soldock/contracts";
import { type ProblemDetails, problemResponse } from "../http/problem.ts";

/**
 * An expected failure of an operation. REST returns it as problem+json with the status of its
 * code, and MCP returns it as a tool error with the same code.
 */
export class OperationError extends Error {
	readonly code: ErrorCode;
	readonly detail: string;

	constructor(code: ErrorCode, detail: string) {
		super(detail);
		this.name = "OperationError";
		this.code = code;
		this.detail = detail;
	}

	get status(): number {
		return ERRORS[this.code].status;
	}

	toProblem(extra: Pick<ProblemDetails, "instance" | "requestId"> = {}): ProblemDetails {
		return {
			type: "about:blank",
			title: ERRORS[this.code].title,
			status: this.status,
			code: this.code,
			detail: this.detail,
			...extra,
		};
	}

	toResponse(extra: Pick<ProblemDetails, "instance" | "requestId"> = {}): Response {
		return problemResponse(this.toProblem(extra));
	}
}
