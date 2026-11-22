import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { getPinnedHttps, isPublicIpv4, requestUrl } from "./network";

test("rejects new schemes, credentials, address literals and alternate ports", () => {
  for (const url of [
    "http://api.example.com/",
    "https://user:pass@api.example.com/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://api.example.com:8443/",
  ]) {
    expect(requestUrl(url)).toBeUndefined();
  }
  expect(requestUrl("https://api.example.com/path")?.hostname).toBe(
    "api.example.com",
  );
});

test("refuses DNS results for loopback, LAN, tailnet and link-local destinations", () => {
  for (const address of [
    "127.0.0.1",
    "192.168.1.1",
    "100.100.100.100",
    "169.254.169.254",
    "::1",
  ]) {
    expect(isPublicIpv4(address)).toBe(false);
  }
  expect(isPublicIpv4("8.8.8.8")).toBe(true);
});

test("the pinned HTTPS request checks the hostname, skips redirects and caps the body", async () => {
  const folder = mkdtempSync(join(tmpdir(), "aphelion-proxy-"));
  onTestFinished(() => {
    rmSync(folder, { recursive: true, force: true });
  });
  const key = join(folder, "key.pem");
  const cert = join(folder, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-noenc",
      "-days",
      "1",
      "-subj",
      "/CN=api.example.test",
      "-addext",
      "subjectAltName=DNS:api.example.test",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  const ca = readFileSync(cert, "utf8");
  const calls: string[] = [];
  const server = createServer(
    { key: readFileSync(key), cert: ca },
    (req, res) => {
      calls.push(`${req.headers.host ?? ""} ${req.url ?? ""}`);
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/target" }).end();
      } else {
        res.end(Buffer.alloc(65 * 1024));
      }
    },
  );
  onTestFinished(
    () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No TCP address");
  const get = (host: string, path: string) =>
    getPinnedHttps(
      new URL(`https://${host}:${String(address.port)}${path}`),
      "127.0.0.1",
      AbortSignal.timeout(2000),
      ca,
    );
  expect(await get("api.example.test", "/redirect")).toEqual({
    status: 302,
    body: "",
  });
  await expect(get("other.example.test", "/redirect")).rejects.toThrow();
  await expect(get("api.example.test", "/large")).rejects.toThrow(
    "Response is too large",
  );
  expect(calls).toEqual([
    "api.example.test /redirect",
    "api.example.test /large",
  ]);
});
