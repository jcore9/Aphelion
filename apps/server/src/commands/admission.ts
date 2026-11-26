import { Clock, Duration, Effect, Option } from "effect";
import type { DeviceId } from "../devices";

export const maxInFlightPerDevice = 8;
export const mutationsPerMinute = 60;

const rateWindowMs = Duration.toMillis(Duration.minutes(1));

export type WorkKind = "read" | "mutation";

export interface Admission {
  readonly guard: <A>(
    device: DeviceId,
    kind: WorkKind,
    work: Effect.Effect<A>,
  ) => Effect.Effect<Option.Option<A>>;
}

export interface AdmissionLimits {
  readonly maxInFlight?: number;
  readonly perMinute?: number;
}

export const createAdmission = ({
  maxInFlight = maxInFlightPerDevice,
  perMinute = mutationsPerMinute,
}: AdmissionLimits = {}): Admission => {
  const inFlight = new Map<DeviceId, number>();
  const mutations = new Map<DeviceId, number[]>();

  const enter = (device: DeviceId, kind: WorkKind, at: number) => {
    const running = inFlight.get(device) ?? 0;
    if (running >= maxInFlight) return false;
    if (kind === "mutation") {
      const recent = (mutations.get(device) ?? []).filter(
        (sentAt) => sentAt > at - rateWindowMs,
      );
      if (recent.length >= perMinute) {
        mutations.set(device, recent);
        return false;
      }
      mutations.set(device, [...recent, at]);
    }
    inFlight.set(device, running + 1);
    return true;
  };

  const leave = (device: DeviceId) => {
    const running = (inFlight.get(device) ?? 1) - 1;
    if (running <= 0) inFlight.delete(device);
    else inFlight.set(device, running);
  };

  return {
    guard: (device, kind, work) =>
      Effect.acquireUseRelease(
        Effect.map(Clock.currentTimeMillis, (at) => enter(device, kind, at)),
        (admitted) =>
          admitted
            ? Effect.map(work, Option.some)
            : Effect.succeed(Option.none()),
        (admitted) =>
          Effect.sync(() => {
            if (admitted) leave(device);
          }),
      ),
  };
};
