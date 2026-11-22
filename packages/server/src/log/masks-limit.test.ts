import { expect, test } from "vitest";
import { maskLimit, maskSecretValue, unmaskSecretValue } from "./masks";
import { REDACTED, redactText } from "./redact";

test("refuses new values once the list is full, until one is removed", () => {
  const values = Array.from(
    { length: maskLimit },
    (_, i) => `Limit-${String(i).padStart(5, "0")}`,
  );
  for (const value of values) expect(maskSecretValue(value)).toBe("masked");

  expect(maskSecretValue("Limit-overflow")).toBe("list full");
  expect(redactText("Limit-overflow")).toBe("Limit-overflow");
  expect(redactText(values[0] ?? "")).toBe(REDACTED);
  expect(maskSecretValue("Short7x")).toBe("too short");

  unmaskSecretValue(values[0] ?? "");
  expect(maskSecretValue("Limit-overflow")).toBe("masked");
  expect(redactText("Limit-overflow")).toBe(REDACTED);
});
