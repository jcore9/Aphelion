import { BunHttpServer } from "@effect/platform-bun";
import type { Config } from "../config";

export type Listen = Pick<Config["server"], "address" | "port">;

export const webSocketLimits = {
  maxPayloadLength: 1024 * 1024,
  highWaterMark: 2 * 1024 * 1024,
  backpressureLimit: 1024 * 1024,
  closeOnBackpressureLimit: true,
  idleTimeout: 60,
} as const;

export const bunHttpServer = ({ address, port }: Listen) =>
  BunHttpServer.layer({
    hostname: address,
    port,
    idleTimeout: 10,
    maxRequestBodySize: 64 * 1024,
    websocket: webSocketLimits,
  });
