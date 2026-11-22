import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { Effect } from "effect";
import { z } from "zod";
import { rpcErrors, type RpcError } from "./json-rpc";

export const requestParams = z.strictObject({ url: z.string().max(4096) });

export function requestUrl(text: string): URL | undefined {
  const url = URL.parse(text);
  if (
    url?.protocol === "https:" &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.hash &&
    !isIP(url.hostname) &&
    !url.hostname.startsWith("[") &&
    url.hostname.includes(".") &&
    !url.hostname.endsWith(".")
  ) {
    return url;
  }
  return undefined;
}

const nonPublic = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  nonPublic.addSubnet(network, prefix);
}

export type NetworkRequest = (
  url: URL,
) => Effect.Effect<
  { readonly status: number; readonly body: string },
  RpcError
>;

const maxResponseBytes = 64 * 1024;

export const isPublicIpv4 = (address: string) =>
  isIP(address) === 4 && !nonPublic.check(address);

export const networkRequest: NetworkRequest = (url) =>
  Effect.tryPromise({
    try: async (interrupted) => {
      const signal = AbortSignal.any([interrupted, AbortSignal.timeout(5000)]);
      const { address } = await lookup(url.hostname + ".", { family: 4 });
      if (signal.aborted || !isPublicIpv4(address))
        throw new Error("Destination is unavailable");
      return await getPinnedHttps(url, address, signal);
    },
    catch: () => rpcErrors.operationFailed,
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.mapError(() => rpcErrors.operationFailed),
  );

export function getPinnedHttps(
  url: URL,
  address: string,
  signal: AbortSignal,
  ca?: string,
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    // Connect to the exact address we checked while verifying TLS against the granted name.
    const outgoing = request(
      {
        hostname: address,
        port: url.port || 443,
        ca,
        servername: url.hostname,
        headers: { host: url.hostname },
        path: url.pathname + url.search,
        agent: false,
        signal,
      },
      (incoming) => {
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        incoming.on("error", reject);
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxResponseBytes) {
            incoming.destroy();
            reject(new Error("Response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}
