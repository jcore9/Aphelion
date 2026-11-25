import { expect, test } from "vitest";
import {
  maskLimit,
  MaskListFullError,
  maskSecretValue,
  unmaskSecretValue,
  redactText,
} from "../log";
import { Secret } from ".";

test("refuses to make a Secret when its value can't be masked", () => {
  const values = Array.from(
    { length: maskLimit },
    (_, i) => `Full-${String(i).padStart(5, "0")}`,
  );
  for (const value of values) maskSecretValue(value);

  expect(() => Secret.make("Unmaskable-value")).toThrow(MaskListFullError);
  const Unchecked = Secret as unknown as new (...args: unknown[]) => Secret;
  expect(() => new Unchecked("Unmaskable-value")).toThrow(TypeError);
  expect(redactText("Unmaskable-value")).toBe("Unmaskable-value");

  unmaskSecretValue(values[0] ?? "");
  expect(Secret.make("Unmaskable-value").reveal()).toBe("Unmaskable-value");
});
