import { BunHttpServer } from "@effect/platform-bun";
import { maxPromptLength } from "@aphelion/protocol";
import type { Config } from "../config";

export type Listen = Pick<Config["server"], "address" | "port">;

const jsonEscapeBytes = 6;
const commandEnvelopeBytes = 1024;
const maxCommandBytes =
  maxPromptLength * jsonEscapeBytes + commandEnvelopeBytes;

export const webSocketLimits = {
  maxPayloadLength: maxCommandBytes,
  highWaterMark: 2 * maxCommandBytes,
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
