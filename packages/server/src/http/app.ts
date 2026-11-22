import { Context, Data, Effect, Layer } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

export class Unauthenticated extends Data.TaggedError("Unauthenticated") {}

export class Authenticator extends Context.Service<
  Authenticator,
  {
    readonly authenticate: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<void, Unauthenticated>;
  }
>()("aphelion/http/Authenticator") {}

export const refuseEveryone = Layer.succeed(Authenticator, {
  authenticate: () => Effect.fail(new Unauthenticated()),
});

const healthy = HttpServerResponse.text('{"status":"ok"}', {
  contentType: "application/json",
});
const unauthorized = HttpServerResponse.empty({ status: 401 });
const notFound = HttpServerResponse.empty({ status: 404 });

export const app = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const path = request.url.split("?", 1)[0];
  if (request.method === "GET" && path === "/health") return healthy;

  const { authenticate } = yield* Authenticator;
  return yield* authenticate(request).pipe(
    Effect.as(notFound),
    Effect.catchTag("Unauthenticated", () => Effect.succeed(unauthorized)),
  );
});
