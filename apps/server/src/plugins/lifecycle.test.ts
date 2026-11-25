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
      { type: "arm", run: 1, deadline: "launch", ms: policy.launchMs },
      { type: "initialize" },
      { type: "arm", run: 1, deadline: "handshake", ms: policy.handshakeMs },
    ]);
  });

  it("schedules a restart with a growing delay after each crash", () => {
    const { state, commands } = play([
      ...toRunning,
      { type: "exited", run: 1, at: 10 },
      { type: "timer", run: 1, deadline: "retry" },
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

  it("waits 1, 2, 4, 8 and 16 seconds, then gives up after the sixth crash", () => {
    expect(
      Array.from({ length: policy.maxCrashes }, (_, i) =>
        retryDelay(i + 1, policy),
      ),
    ).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    const events: LifecycleEvent[] = [{ type: "start" }];
    for (let run = 1; run <= policy.maxCrashes + 1; run++) {
      events.push(
        { type: "exited", run, at: 0 },
        { type: "timer", run, deadline: "retry" },
      );
    }
    expect(play(events).state).toEqual({
      state: "stopped",
      run: policy.maxCrashes + 1,
      reason: "crashed too often",
    });
  });

  it("counts a crash just before the stable time as another in the row", () => {
    const running: LifecycleState = {
      state: "running",
      run: 3,
      crashes: 2,
      since: 1_000,
    };
    for (const type of ["exited", "broke-protocol"] as const) {
      const next = step(
        running,
        { type, run: 3, at: 1_000 + policy.stableMs - 1 },
        policy,
      );
      expect(next.state).toMatchObject({ state: "crashed", crashes: 3 });
      expect(next.commands.some((command) => command.type === "kill")).toBe(
        type === "broke-protocol",
      );
    }
  });

  it("counts a crash at the stable time as the first in the row", () => {
    const running: LifecycleState = {
      state: "running",
      run: 3,
      crashes: 2,
      since: 1_000,
    };
    for (const type of ["exited", "broke-protocol"] as const) {
      const next = step(
        running,
        { type, run: 3, at: 1_000 + policy.stableMs },
        policy,
      );
      expect(next.state).toMatchObject({ state: "crashed", crashes: 1 });
    }
  });

  it("forgives earlier crashes once a run stayed up long enough", () => {
    const { state } = play([
      { type: "start" },
      { type: "exited", run: 1, at: 0 },
      { type: "timer", run: 1, deadline: "retry" },
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
      { type: "timer", run: 1, deadline: "handshake" },
    ]);
    expect(state).toMatchObject({ state: "crashed", crashes: 1 });
    expect(commands).toContainEqual({ type: "kill" });
  });

  it("arms the launch deadline when the spawn command goes out", () => {
    expect(play([{ type: "start" }]).commands).toEqual([
      { type: "spawn", run: 1 },
      { type: "arm", run: 1, deadline: "launch", ms: policy.launchMs },
    ]);
  });

  it("counts one crash and stops the run when the launch deadline passes", () => {
    const { state, commands } = play([
      { type: "start" },
      { type: "timer", run: 1, deadline: "launch" },
    ]);
    expect(state).toMatchObject({ state: "crashed", run: 1, crashes: 1 });
    expect(commands).toContainEqual({ type: "kill" });
    expect(commands).toContainEqual({
      type: "arm",
      run: 1,
      deadline: "retry",
      ms: policy.firstRetryMs,
    });
  });

  it("ignores the launch deadline once the plugin has launched", () => {
    const { state, commands } = play([
      { type: "start" },
      { type: "spawned", run: 1 },
      { type: "timer", run: 1, deadline: "launch" },
    ]);
    expect(state).toMatchObject({ state: "starting", phase: "handshaking" });
    expect(commands).not.toContainEqual({ type: "kill" });
  });

  it("ignores the handshake deadline while the plugin is still launching", () => {
    const { state } = play([
      { type: "start" },
      { type: "timer", run: 1, deadline: "handshake" },
    ]);
    expect(state).toMatchObject({ state: "starting", phase: "launching" });
  });

  it("starts the handshake deadline when initialize is sent, not at launch", () => {
    const launched = play([{ type: "start" }]);
    expect(launched.commands).toContainEqual({ type: "spawn", run: 1 });
    expect(
      step(launched.state, { type: "spawned", run: 1 }, policy).commands,
    ).toContainEqual({
      type: "arm",
      run: 1,
      deadline: "handshake",
      ms: policy.handshakeMs,
    });
  });

  it("doesn't cut the shutdown grace short when the handshake deadline fires", () => {
    const { state, commands } = play([
      { type: "start" },
      { type: "spawned", run: 1 },
      { type: "ready", run: 1, at: 1_000 },
      { type: "stop" },
      { type: "timer", run: 1, deadline: "handshake" },
    ]);
    expect(state).toEqual({ state: "stopping", run: 1 });
    expect(commands).not.toContainEqual({ type: "kill" });
  });

  it("doesn't skip the restart wait when the handshake deadline fires", () => {
    const { state, commands } = play([
      { type: "start" },
      { type: "spawned", run: 1 },
      { type: "exited", run: 1, at: 9_000 },
      { type: "timer", run: 1, deadline: "handshake" },
    ]);
    expect(state).toMatchObject({ state: "crashed", run: 1 });
    expect(commands).not.toContainEqual({ type: "spawn", run: 2 });
  });

  it("ignores timers and process events from an earlier run", () => {
    const restarted = play([
      { type: "start" },
      { type: "exited", run: 1, at: 0 },
      { type: "timer", run: 1, deadline: "retry" },
      { type: "spawned", run: 2 },
    ]).state;
    expect(restarted).toMatchObject({ state: "starting", run: 2 });
    for (const stale of [
      { type: "timer", run: 1, deadline: "handshake" },
      { type: "exited", run: 1, at: 0 },
      { type: "spawned", run: 1 },
      { type: "killed", run: 1 },
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
      { type: "arm", run: 1, deadline: "grace", ms: policy.graceMs },
    ]);
    const killed = play(
      [
        { type: "timer", run: 1, deadline: "grace" },
        { type: "killed", run: 1 },
      ],
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
      { type: "timer", run: 1, deadline: "retry" },
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
      phase: "launching",
      run: 5,
      crashes: 0,
    });
  });
});
