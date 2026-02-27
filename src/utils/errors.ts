export type ErrorCode =
  | "INVALID_MINT_ADDRESS"
  | "TOKEN_NOT_FOUND"
  | "RPC_ERROR"
  | "INTERNAL_ERROR";

const STATUS_MAP: Record<ErrorCode, number> = {
  INVALID_MINT_ADDRESS: 400,
  TOKEN_NOT_FOUND: 404,
  RPC_ERROR: 503,
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
