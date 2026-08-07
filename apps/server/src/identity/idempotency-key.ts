import { idempotencyKeySchema } from "@oloka/contracts";
import { IdentityError } from "./identity-service.js";

export function parseIdempotencyKey(value: unknown): string {
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new IdentityError("VALIDATION_ERROR", "idempotency_key_invalid");
  }
  return parsed.data;
}
