import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import { describe } from "vitest";
import { deviceId } from "../devices";
import {
  createAdmission,
  maxInFlightPerDevice,
  mutationsPerMinute,
  type Permit,
} from "./admission";

const laptop = deviceId.parse("0123456789abcdef");
const phone = deviceId.parse("fedcba9876543210");

describe("command admission", () => {
  it("allows 8 commands in flight and 60 mutations a minute for each device", () => {
    expect(maxInFlightPerDevice).toBe(8);
    expect(mutationsPerMinute).toBe(60);
  });

  it.effect(
    "refuses a command past the in-flight limit, for that device only",
    () =>
      Effect.gen(function* () {
        const admission = createAdmission({ maxInFlight: 2 });
        const gate = yield* Deferred.make<undefined>();
        const slow = Deferred.await(gate).pipe(Effect.as("done"));
        const held = [
          yield* Effect.forkChild(admission.guard(laptop, "read", () => slow)),
          yield* Effect.forkChild(admission.guard(laptop, "read", () => slow)),
        ];
        yield* Effect.yieldNow;

        expect(
          yield* admission.guard(laptop, "read", () => Effect.succeed("late")),
        ).toEqual(Option.none());
        expect(
          yield* admission.guard(phone, "read", () => Effect.succeed("other")),
        ).toEqual(Option.some("other"));

        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.joinAll(held);
        expect(
          yield* admission.guard(laptop, "read", () => Effect.succeed("again")),
        ).toEqual(Option.some("again"));
      }),
  );

  it.effect("frees the place of a command that failed or was interrupted", () =>
    Effect.gen(function* () {
      const admission = createAdmission({ maxInFlight: 1 });
      yield* Effect.exit(
        admission.guard(laptop, "read", () => Effect.die("boom")),
      );
      const stuck = yield* Effect.forkChild(
        admission.guard(laptop, "read", () => Effect.never),
      );
      yield* Effect.yieldNow;
      expect(
        yield* admission.guard(laptop, "read", () => Effect.succeed("x")),
      ).toEqual(Option.none());
      yield* Fiber.interrupt(stuck);

      expect(
        yield* admission.guard(laptop, "read", () => Effect.succeed("y")),
      ).toEqual(Option.some("y"));
      expect(Exit.isFailure(yield* Fiber.await(stuck))).toBe(true);
    }),
  );

  it.effect(
    "refuses a mutation past the minute's limit, and lets one in when the minute passes",
    () =>
      Effect.gen(function* () {
        const admission = createAdmission({ perMinute: 3 });
        const mutate = (device = laptop) =>
          admission.guard(device, "mutation", () => Effect.succeed("ok"));
        for (let sent = 0; sent < 3; sent += 1) {
          expect(yield* mutate()).toEqual(Option.some("ok"));
          yield* TestClock.adjust("10 seconds");
        }

        expect(yield* mutate()).toEqual(Option.none());
        expect(yield* mutate(phone)).toEqual(Option.some("ok"));
        yield* TestClock.adjust("30 seconds");
        expect(yield* mutate()).toEqual(Option.some("ok"));
        expect(yield* mutate()).toEqual(Option.none());
      }),
  );

  it.effect("doesn't count a read against the mutation rate", () =>
    Effect.gen(function* () {
      const admission = createAdmission({ perMinute: 1 });
      for (let sent = 0; sent < 5; sent += 1) {
        expect(
          yield* admission.guard(laptop, "read", () => Effect.succeed("ok")),
        ).toEqual(Option.some("ok"));
      }
      expect(
        yield* admission.guard(laptop, "mutation", () => Effect.succeed("ok")),
      ).toEqual(Option.some("ok"));
    }),
  );

  it.effect(
    "keeps a place until every holder of the permit has released it",
    () =>
      Effect.gen(function* () {
        const admission = createAdmission({ maxInFlight: 1 });
        const handoff: { held?: Permit } = {};
        yield* admission.guard(laptop, "read", (permit) =>
          Effect.sync(() => {
            handoff.held = permit.retain();
          }),
        );

        expect(
          yield* admission.guard(laptop, "read", () => Effect.succeed("x")),
        ).toEqual(Option.none());

        handoff.held?.release();
        handoff.held?.release();
        expect(
          yield* admission.guard(laptop, "read", () => Effect.succeed("y")),
        ).toEqual(Option.some("y"));
      }),
  );
});
