import { expect, test } from "vitest";
import { requestUrl } from "./wire.ts";

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
