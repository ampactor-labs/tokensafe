export type ErrorCode =
  | "MISSING_REQUIRED_PARAM"
  | "INVALID_MINT_ADDRESS"
  | "TOKEN_NOT_FOUND"
  | "RPC_ERROR"
  | "RATE_LIMITED"
  | "TOO_MANY_MINTS"
  | "UNAUTHORIZED"
  | "WEBHOOK_NOT_FOUND"
  | "WEBHOOK_LIMIT_EXCEEDED"
  | "INVALID_API_KEY"
  | "API_KEY_EXPIRED"
  | "API_KEY_LIMIT_EXCEEDED"
  | "AUDIT_NOT_FOUND"
  | "INTERNAL_ERROR";

const STATUS_MAP: Record<ErrorCode, number> = {
  MISSING_REQUIRED_PARAM: 400,
  INVALID_MINT_ADDRESS: 400,
  TOKEN_NOT_FOUND: 404,
  RPC_ERROR: 503,
  RATE_LIMITED: 429,
  TOO_MANY_MINTS: 400,
  UNAUTHORIZED: 401,
  WEBHOOK_NOT_FOUND: 404,
  WEBHOOK_LIMIT_EXCEEDED: 400,
  INVALID_API_KEY: 401,
  API_KEY_EXPIRED: 401,
  API_KEY_LIMIT_EXCEEDED: 429,
  AUDIT_NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: string;

  constructor(code: ErrorCode, message: string, details?: string) {
    super(message);
    this.code = code;
    this.status = STATUS_MAP[code];
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details && { details: this.details }),
      },
    };
  }
}
