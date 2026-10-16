// Public surface of the platform module. Other modules import from here, never from its files.
export { PROBLEM_CONTENT_TYPE, type ProblemDetails, problemResponse } from "./http/problem.ts";
export { REQUEST_ID_HEADER, type RequestIdVariables, requestId } from "./http/request-id.ts";
