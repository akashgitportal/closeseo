export type ErrorCode =
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "CONFLICT"
  | "BUDGET_EXCEEDED"
  | "NOT_CONFIGURED"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_ERROR"
  | "UPSTREAM_BILLING"
  | "UPSTREAM_PAUSED"
  | "INTERNAL_ERROR";

const STATUS: Record<ErrorCode, number> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  CONFLICT: 409,
  BUDGET_EXCEEDED: 402,
  NOT_CONFIGURED: 412,
  UPSTREAM_UNAVAILABLE: 503,
  UPSTREAM_ERROR: 502,
  UPSTREAM_BILLING: 502,
  UPSTREAM_PAUSED: 503,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message?: string) {
    super(message ?? code);
    this.name = "AppError";
    this.code = code;
  }
  get status() {
    return STATUS[this.code];
  }
}
