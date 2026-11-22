import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const tokenPrefix = "aph_dev_";

export const deviceId = z
  .string()
  .regex(/^[0-9a-f]{16}$/)
  .brand<"DeviceId">();
export type DeviceId = z.infer<typeof deviceId>;

const deviceToken = z
  .string()
  .regex(/^aph_dev_([0-9a-f]{16})_[A-Za-z0-9_-]{43}$/)
  .transform((token) => ({
    token,
    id: deviceId.parse(
      token.slice(tokenPrefix.length, tokenPrefix.length + 16),
    ),
  }));

export interface NewToken {
  readonly id: DeviceId;
  readonly token: string;
  readonly hash: Uint8Array;
}

export function hashToken(token: string): Uint8Array {
  return createHash("sha256").update(token, "utf8").digest();
}

export function newToken(): NewToken {
  const id = deviceId.parse(randomBytes(8).toString("hex"));
  const token = `${tokenPrefix}${id}_${randomBytes(32).toString("base64url")}`;
  return { id, token, hash: hashToken(token) };
}

export function parseToken(
  text: string,
): { readonly token: string; readonly id: DeviceId } | undefined {
  const parsed = deviceToken.safeParse(text);
  return parsed.success ? parsed.data : undefined;
}

const nothing = new Uint8Array(32);

export function tokenMatches(
  token: string | undefined,
  stored: Uint8Array | undefined,
): boolean {
  const expected = stored?.byteLength === 32 ? stored : nothing;
  const same = timingSafeEqual(hashToken(token ?? ""), expected);
  return same && token !== undefined && expected !== nothing;
}
