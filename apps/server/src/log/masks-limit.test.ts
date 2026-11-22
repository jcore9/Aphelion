import { expect, test } from "vitest";
import {
  maskLimit,
  MaskListFullError,
  maskSecretValue,
  unmaskSecretValue,
} from "./masks";
import { REDACTED, redactText } from "./redact";

test("throws once the list is full, adds nothing, and keeps earlier values masked", () => {
  const values = Array.from(
    { length: maskLimit },
    (_, i) => `Limit-${String(i).padStart(5, "0")}`,
  );
  for (const value of values) expect(maskSecretValue(value)).toBe("masked");

  expect(() => maskSecretValue("Limit-overflow")).toThrow(MaskListFullError);
  expect(redactText("Limit-overflow")).toBe("Limit-overflow");
  expect(redactText(Buffer.from("Limit-overflow").toString("base64"))).toBe(
    Buffer.from("Limit-overflow").toString("base64"),
  );
  for (const value of [values[0], values[5000], values[maskLimit - 1]]) {
    expect(redactText(`x ${value ?? ""} y`)).toBe(`x ${REDACTED} y`);
  }
  expect(maskSecretValue(values[0] ?? "")).toBe("masked");
  expect(maskSecretValue("Short7x")).toBe("too short");

  unmaskSecretValue(values[0] ?? "");
  expect(() => maskSecretValue("Limit-overflow")).toThrow(MaskListFullError);
  unmaskSecretValue(values[0] ?? "");
  expect(maskSecretValue("Limit-overflow")).toBe("masked");
  expect(redactText("Limit-overflow")).toBe(REDACTED);
});
