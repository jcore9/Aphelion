import { Layer } from "effect";
import { HttpServer } from "effect/http";
import { bunHttpServer, type Listen } from "../adapters/http-server";
import type { EventLog } from "../history";
import type { Database } from "../store";
import { app, History } from "./app";
import { deviceTokens, type DeviceTokenOptions } from "./authenticator";

export type { Listen } from "../adapters/http-server";
export type { DeviceTokenOptions } from "./authenticator";

export const serveHttp = (
  listen: Listen,
  db: Database,
  history: EventLog,
  options?: DeviceTokenOptions,
) =>
  HttpServer.serve(app).pipe(
    Layer.provide(deviceTokens(db, options)),
    Layer.provide(Layer.succeed(History, history)),
    Layer.provideMerge(bunHttpServer(listen)),
  );
