import { Layer } from "effect";
import { HttpServer } from "effect/http";
import { bunHttpServer, type Listen } from "../adapters/http-server";
import { app, refuseEveryone } from "./app";

export type { Listen } from "../adapters/http-server";

export const serveHttp = (listen: Listen) =>
  HttpServer.serve(app).pipe(
    Layer.provide(refuseEveryone),
    Layer.provideMerge(bunHttpServer(listen)),
  );
