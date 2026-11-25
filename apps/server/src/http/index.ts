import { Layer } from "effect";
import { HttpServer } from "effect/http";
import { bunHttpServer, type Listen } from "../adapters/http-server";
import type { Database } from "../store";
import { app } from "./app";
import { deviceTokens, type DeviceTokenOptions } from "./authenticator";

export type { Listen } from "../adapters/http-server";
export type { DeviceTokenOptions } from "./authenticator";

export const serveHttp = (
  listen: Listen,
  db: Database,
  options?: DeviceTokenOptions,
) =>
  HttpServer.serve(app).pipe(
    Layer.provide(deviceTokens(db, options)),
    Layer.provideMerge(bunHttpServer(listen)),
  );
