import { Clock, Duration, Effect, Layer } from "effect";
import {
  checkAuthorization,
  defaultFailureAuditLimit,
  failureAuditor,
  isDeviceActive,
  type FailureAuditLimit,
} from "../devices";
import type { Database } from "../store";
import { Authenticator, Unauthenticated } from "./app";

export interface DeviceTokenOptions {
  readonly recheckEvery?: Duration.Duration;
  readonly failureAuditLimit?: FailureAuditLimit;
}

const now = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms));

export const deviceTokens = (
  db: Database,
  {
    recheckEvery = Duration.seconds(5),
    failureAuditLimit = defaultFailureAuditLimit,
  }: DeviceTokenOptions = {},
) =>
  Layer.sync(Authenticator, () => {
    const auditFailure = failureAuditor(db, failureAuditLimit);
    return {
      recheckEvery,
      authenticate: (request) =>
        Effect.flatMap(now, (at) => {
          const verdict = checkAuthorization(
            db,
            request.headers["authorization"],
            at,
          );
          if (verdict.ok) return Effect.succeed(verdict.device);
          auditFailure(verdict, at);
          return Effect.fail(new Unauthenticated());
        }),
      stillValid: (device) =>
        Effect.map(now, (at) => isDeviceActive(db, device.id, at)),
    };
  });
