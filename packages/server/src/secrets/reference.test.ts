import { describe, expect, test } from "vitest";
import { parseSecretReference, referenceReasons } from ".";

describe("parseSecretReference", () => {
  test.each([
    [
      "op://AI Agents/GitHub App/private key",
      "op",
      "AI Agents/GitHub App/private key",
    ],
    ["op://vault/item/field", "op", "vault/item/field"],
    ["op://vault/item/section/field", "op", "vault/item/section/field"],
    [
      "op://dev_v1/web-app.prod/one time/totp?attribute=otp",
      "op",
      "dev_v1/web-app.prod/one time/totp?attribute=otp",
    ],
    [
      "op://vault/item/one-time password?attribute=totp",
      "op",
      "vault/item/one-time password?attribute=totp",
    ],
    [
      "op://vault/SSH key/private key?ssh-format=openssh",
      "op",
      "vault/SSH key/private key?ssh-format=openssh",
    ],
    [
      "op://abcdefghijklmnopqrstuvwxyz/item/field",
      "op",
      "abcdefghijklmnopqrstuvwxyz/item/field",
    ],
    [
      "bws://64246aa4-70b3-4332-8587-8b1284ce6d76",
      "bws",
      "64246aa4-70b3-4332-8587-8b1284ce6d76",
    ],
    [
      "bws://BE8E0AD8-D545-4017-A55A-B02F014D4158",
      "bws",
      "be8e0ad8-d545-4017-a55a-b02f014d4158",
    ],
    ["local://github/webhook-secret", "local", "github/webhook-secret"],
    ["local://openai.key", "local", "openai.key"],
    ["local://a/b_c/0", "local", "a/b_c/0"],
  ])("accepts %j", (text, scheme, path) => {
    expect(parseSecretReference(text)).toEqual({
      ok: true,
      reference: { scheme, path },
    });
  });

  test.each([
    [42, referenceReasons.text],
    [`local://${"a".repeat(1017)}`, referenceReasons.text],
    ["", referenceReasons.scheme],
    ["vault/item/field", referenceReasons.scheme],
    ["OP://vault/item/field", referenceReasons.scheme],
    ["op:/vault/item/field", referenceReasons.scheme],
    ["https://vault/item/field", referenceReasons.scheme],
    ["ops://vault/item/field", referenceReasons.scheme],
    [" op://vault/item/field", referenceReasons.scheme],
    ["op://vault/item", referenceReasons.op],
    ["op://vault/item/section/field/extra", referenceReasons.op],
    ["op://vault//field", referenceReasons.op],
    ["op://vault/item/field/", referenceReasons.op],
    ["op://vault/ item/field", referenceReasons.op],
    ["op://vault/item /field", referenceReasons.op],
    ["op://vault/item/fi\teld", referenceReasons.op],
    ["op://vault/item/fi\neld", referenceReasons.op],
    ["op://vault/Wetter Zürich/field", referenceReasons.op],
    ["op://vault/it\u200bem/field", referenceReasons.op],
    ["op://vault/item/field\u00a0", referenceReasons.op],
    ["op://vault/item/field?attribute=password", referenceReasons.opQuery],
    ["op://vault/item/field?attribute=otp?x", referenceReasons.opQuery],
    ["op://vault/item/field?", referenceReasons.opQuery],
    [
      "op://vault/item/field?attribute=otp&ssh-format=openssh",
      referenceReasons.opQuery,
    ],
    ["bws://", referenceReasons.bws],
    ["bws://64246aa4-70b3-4332-8587-8b1284ce6d7", referenceReasons.bws],
    ["bws://64246aa4-70b3-4332-8587-8b1284ce6d76/extra", referenceReasons.bws],
    ["bws://64246aa470b3433285878b1284ce6d76", referenceReasons.bws],
    ["local://", referenceReasons.local],
    ["local://Github/token", referenceReasons.local],
    ["local://github//token", referenceReasons.local],
    ["local://../token", referenceReasons.local],
    ["local://./token", referenceReasons.local],
    ["local://github/", referenceReasons.local],
    ["local://git hub", referenceReasons.local],
  ])("refuses %j with a fixed reason", (text, reason) => {
    expect(parseSecretReference(text)).toEqual({ ok: false, reason });
  });

  test("never repeats the text it was given", () => {
    const hostile = "op://vault/item/field?attribute=ghp_canaryCanaryCanary";
    const result = parseSecretReference(hostile);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("canary");
    expect(Object.values(referenceReasons)).toContain(
      result.ok ? "" : result.reason,
    );
  });
});
