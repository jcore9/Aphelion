import { Context, Data, Duration, Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Device } from "../devices";
import { serveSocket } from "./socket";

export class Unauthenticated extends Data.TaggedError("Unauthenticated") {}

export class Authenticator extends Context.Service<
  Authenticator,
  {
    readonly authenticate: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<Device, Unauthenticated>;
    readonly stillValid: (device: Device) => Effect.Effect<boolean>;
    readonly recheckEvery: Duration.Duration;
  }
>()("aphelion/http/Authenticator") {}

const healthy = HttpServerResponse.text('{"status":"ok"}', {
  contentType: "application/json",
});
const unauthorized = HttpServerResponse.empty({ status: 401 });
const notFound = HttpServerResponse.empty({ status: 404 });
const badRequest = HttpServerResponse.empty({ status: 400 });
const closed = HttpServerResponse.empty();

export const app = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.method === "GET" && request.url === "/health") return healthy;

  const auth = yield* Authenticator;
  const device = yield* auth.authenticate(request);
  if (request.method !== "GET" || request.url !== "/ws") return notFound;

  return yield* request.upgrade.pipe(
    Effect.flatMap((socket) =>
      serveSocket(socket, auth.stillValid(device), auth.recheckEvery),
    ),
    Effect.as(closed),
    Effect.catchTag("HttpServerError", () => Effect.succeed(badRequest)),
    Effect.interruptible,
  );
}).pipe(Effect.catchTag("Unauthenticated", () => Effect.succeed(unauthorized)));
