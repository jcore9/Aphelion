import { describe, expect, it } from "vitest";
import {
  defaultRestartPolicy as policy,
  installed,
  retryDelay,
  step,
  type LifecycleEvent,
  type LifecycleState,
} from "./lifecycle";

function play(events: LifecycleEvent[], from: LifecycleState = installed) {
  const commands = [];
  let state = from;
  for (const event of events) {
    const next = step(state, event, policy);
    state = next.state;
    commands.push(...next.commands);
  }
  return { state, commands };
}

const toRunning: LifecycleEvent[] = [
  { type: "start" },
  { type: "spawned", run: 1 },
  { type: "ready", run: 1, at: 0 },
];

describe("the plugin lifecycle", () => {
  it("starts, spawns, initializes and runs", () => {
    const { state, commands } = play(toRunning);
    expect(state).toEqual({ state: "running", run: 1, crashes: 0, since: 0 });
    expect(commands).toEqual([
      { type: "spawn", run: 1 },
      { type: "arm", run: 1, ms: policy.handshakeMs },
      { type: "initialize" },
    ]);
  });

  it("schedules a restart with a growing delay after each crash", () => {
    const { state, commands } = play([
      ...toRunning,
      { type: "exited", run: 1, at: 10 },
      { type: "timer", run: 1 },
      { type: "spawned", run: 2 },
      { type: "exited", run: 2, at: 20 },
    ]);
    expect(state).toEqual({
      state: "crashed",
      run: 2,
      crashes: 2,
      retryInMs: 2 * policy.firstRetryMs,
    });
    expect(commands).toContainEqual({ type: "spawn", run: 2 });
  });

  it("caps the delay and gives up after too many crashes", () => {
    expect(retryDelay(1, policy)).toBe(policy.firstRetryMs);
    expect(retryDelay(30, policy)).toBe(policy.maxRetryMs);
    const events: LifecycleEvent[] = [{ type: "start" }];
    for (let run = 1; run <= policy.maxCrashes + 1; run++) {
      events.push({ type: "exited", run, at: 0 }, { type: "timer", run });
    }
    expect(play(events).state).toEqual({
      state: "stopped",
      run: policy.maxCrashes + 1,
      reason: "crashed too often",
    });
  });

  it("forgives earlier crashes once a run stayed up long enough", () => {
    const { state } = play([
      { type: "start" },
      { type: "exited", run: 1, at: 0 },
      { type: "timer", run: 1 },
      { type: "spawned", run: 2 },
      { type: "ready", run: 2, at: 0 },
      { type: "exited", run: 2, at: policy.stableMs },
    ]);
    expect(state).toMatchObject({ state: "crashed", crashes: 1 });
  });

  it("kills a plugin that doesn't finish the handshake in time", () => {
    const { state, commands } = play([
      { type: "start" },
      { type: "spawned", run: 1 },
      { type: "timer", run: 1 },
    ]);
    expect(state).toMatchObject({ state: "crashed", crashes: 1 });
    expect(commands).toContainEqual({ type: "kill" });
  });

  it("ignores timers and process events from an earlier run", () => {
    const restarted = play([
      { type: "start" },
      { type: "exited", run: 1, at: 0 },
      { type: "timer", run: 1 },
    ]).state;
    expect(restarted).toMatchObject({ state: "starting", run: 2 });
    for (const stale of [
      { type: "timer", run: 1 },
      { type: "exited", run: 1, at: 0 },
      { type: "spawned", run: 1 },
    ] as const) {
      expect(step(restarted, stale, policy)).toEqual({
        state: restarted,
        commands: [],
      });
    }
  });

  it("asks a running plugin to shut down, then kills it after the grace time", () => {
    const asked = play([...toRunning, { type: "stop" }]);
    expect(asked.state).toEqual({ state: "stopping", run: 1 });
    expect(asked.commands.slice(-2)).toEqual([
      { type: "shutdown" },
      { type: "arm", run: 1, ms: policy.graceMs },
    ]);
    const killed = play(
      [{ type: "timer", run: 1 }, { type: "killed" }],
      asked.state,
    );
    expect(killed.commands).toEqual([{ type: "kill" }]);
    expect(killed.state).toEqual({
      state: "stopped",
      run: 1,
      reason: "requested",
    });
  });

  it("treats an exit while stopping as a clean stop, not a crash", () => {
    const { state } = play([
      ...toRunning,
      { type: "stop" },
      { type: "exited", run: 1, at: 5 },
    ]);
    expect(state).toEqual({ state: "stopped", run: 1, reason: "requested" });
  });

  it("cancels a pending restart when stopped", () => {
    const { state } = play([
      { type: "start" },
      { type: "exited", run: 1, at: 0 },
      { type: "stop" },
      { type: "timer", run: 1 },
    ]);
    expect(state).toEqual({ state: "stopped", run: 1, reason: "requested" });
  });

  it("starts again from stopped with a new run number", () => {
    const stopped: LifecycleState = {
      state: "stopped",
      run: 4,
      reason: "requested",
    };
    expect(step(stopped, { type: "start" }, policy).state).toEqual({
      state: "starting",
      run: 5,
      crashes: 0,
    });
  });
});
