import type { ApiKeyRecord } from "../utils/api-keys.js";

declare global {
  namespace Express {
    interface Request {
      id: string;
      apiKeyRecord?: ApiKeyRecord;
    }
  }
}
