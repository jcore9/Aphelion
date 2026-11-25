import { expect, test } from "vitest";
import { maxPluginLineBytes, pluginLineFits, requestUrl } from "./wire.ts";

test("rejects new schemes, credentials, address literals and alternate ports", () => {
  for (const url of [
    "http://api.example.com/",
    "https://user:pass@api.example.com/",
    "https://127.0.0.1/",
    "https://0x7f000001/",
    "https://[::1]/",
    "https://api.example.com:8443/",
    "https://api.example.com/#part",
    "https://localhost/",
    "https://api.example.com./",
  ]) {
    expect(requestUrl(url)).toBeUndefined();
  }
  expect(requestUrl("https://api.example.com/path")?.hostname).toBe(
    "api.example.com",
  );
});

test("accepts a line at the UTF-8 limit and refuses one byte more", () => {
  const ascii = "a".repeat(maxPluginLineBytes);
  expect(pluginLineFits(ascii)).toBe(true);
  expect(pluginLineFits(`${ascii}a`)).toBe(false);
  const euros = `${"€".repeat(Math.floor(maxPluginLineBytes / 3))}${"a".repeat(maxPluginLineBytes % 3)}`;
  expect(pluginLineFits(euros)).toBe(true);
  expect(pluginLineFits(`${euros}a`)).toBe(false);
});
