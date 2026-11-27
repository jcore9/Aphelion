import { Clock, Duration, Effect, Option } from "effect";
import type { DeviceId } from "../devices";

export const maxInFlightPerDevice = 8;
export const mutationsPerMinute = 60;

const rateWindowMs = Duration.toMillis(Duration.minutes(1));

export type WorkKind = "read" | "mutation";

export interface Permit {
  readonly retain: () => Permit;
  readonly release: () => void;
}

export interface Admission {
  readonly guard: <A>(
    device: DeviceId,
    kind: WorkKind,
    work: (permit: Permit) => Effect.Effect<A>,
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

  const permitFor = (device: DeviceId): Permit => {
    let holders = 0;
    const hold = (): Permit => {
      let held = true;
      holders += 1;
      return {
        retain: hold,
        release: () => {
          if (!held) return;
          held = false;
          holders -= 1;
          if (holders === 0) leave(device);
        },
      };
    };
    return hold();
  };

  return {
    guard: (device, kind, work) =>
      Effect.acquireUseRelease(
        Effect.map(Clock.currentTimeMillis, (at) =>
          enter(device, kind, at) ? permitFor(device) : undefined,
        ),
        (permit) =>
          permit === undefined
            ? Effect.succeed(Option.none())
            : Effect.map(work(permit), Option.some),
        (permit) =>
          Effect.sync(() => {
            permit?.release();
          }),
      ),
  };
};
