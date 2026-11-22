import { BunHttpServer } from "@effect/platform-bun";
import type { Config } from "../config";

export type Listen = Pick<Config["server"], "address" | "port">;

export const bunHttpServer = ({ address, port }: Listen) =>
  BunHttpServer.layer({ hostname: address, port, idleTimeout: 10 });
