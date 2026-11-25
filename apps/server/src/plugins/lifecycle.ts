export type StopReason = "requested" | "crashed too often";

export type LifecycleState =
  | { readonly state: "installed"; readonly run: number }
  | {
      readonly state: "starting";
      readonly phase: "launching" | "handshaking";
      readonly run: number;
      readonly crashes: number;
    }
  | {
      readonly state: "running";
      readonly run: number;
      readonly crashes: number;
      readonly since: number;
    }
  | { readonly state: "stopping"; readonly run: number }
  | {
      readonly state: "crashed";
      readonly run: number;
      readonly crashes: number;
      readonly retryInMs: number;
    }
  | {
      readonly state: "stopped";
      readonly run: number;
      readonly reason: StopReason;
    };

export type Deadline = "launch" | "handshake" | "grace" | "retry";

export type LifecycleEvent =
  | { readonly type: "start" }
  | { readonly type: "stop" }
  | { readonly type: "spawned"; readonly run: number }
  | { readonly type: "spawn-failed"; readonly run: number }
  | { readonly type: "ready"; readonly run: number; readonly at: number }
  | {
      readonly type: "broke-protocol";
      readonly run: number;
      readonly at: number;
    }
  | { readonly type: "exited"; readonly run: number; readonly at: number }
  | { readonly type: "killed"; readonly run: number }
  | {
      readonly type: "timer";
      readonly run: number;
      readonly deadline: Deadline;
    };

export type LifecycleCommand =
  | { readonly type: "spawn"; readonly run: number }
  | { readonly type: "initialize" }
  | { readonly type: "shutdown" }
  | { readonly type: "kill" }
  | {
      readonly type: "arm";
      readonly run: number;
      readonly deadline: Deadline;
      readonly ms: number;
    };

export interface RestartPolicy {
  readonly launchMs: number;
  readonly handshakeMs: number;
  readonly graceMs: number;
  readonly firstRetryMs: number;
  readonly maxCrashes: number;
  readonly stableMs: number;
}

export const defaultRestartPolicy: RestartPolicy = {
  launchMs: 15_000,
  handshakeMs: 10_000,
  graceMs: 5_000,
  firstRetryMs: 1_000,
  maxCrashes: 5,
  stableMs: 60_000,
};

export interface Step {
  readonly state: LifecycleState;
  readonly commands: readonly LifecycleCommand[];
}

export const installed: LifecycleState = { state: "installed", run: 0 };

export function retryDelay(crashes: number, policy: RestartPolicy): number {
  return policy.firstRetryMs * 2 ** (crashes - 1);
}

const stay = (state: LifecycleState): Step => ({ state, commands: [] });

function launch(run: number, crashes: number, policy: RestartPolicy): Step {
  return {
    state: { state: "starting", phase: "launching", run, crashes },
    commands: [
      { type: "spawn", run },
      { type: "arm", run, deadline: "launch", ms: policy.launchMs },
    ],
  };
}

function crashCount(
  crashes: number,
  since: number,
  at: number,
  stableMs: number,
): number {
  return at - since >= stableMs ? 1 : crashes + 1;
}

function crash(
  run: number,
  crashes: number,
  policy: RestartPolicy,
  stillAlive: boolean,
): Step {
  const kill: LifecycleCommand[] = stillAlive ? [{ type: "kill" }] : [];
  if (crashes > policy.maxCrashes) {
    return {
      state: { state: "stopped", run, reason: "crashed too often" },
      commands: kill,
    };
  }
  const retryInMs = retryDelay(crashes, policy);
  return {
    state: { state: "crashed", run, crashes, retryInMs },
    commands: [...kill, { type: "arm", run, deadline: "retry", ms: retryInMs }],
  };
}

const awaitedDeadline = (state: LifecycleState): Deadline | undefined => {
  switch (state.state) {
    case "starting":
      return state.phase === "launching" ? "launch" : "handshake";
    case "stopping":
      return "grace";
    case "crashed":
      return "retry";
    default:
      return undefined;
  }
};

const concerns = (state: LifecycleState, event: LifecycleEvent) =>
  (!("run" in event) || event.run === state.run) &&
  (event.type !== "timer" || event.deadline === awaitedDeadline(state));

export function step(
  state: LifecycleState,
  event: LifecycleEvent,
  policy: RestartPolicy,
): Step {
  if (!concerns(state, event)) return stay(state);
  switch (state.state) {
    case "installed":
    case "stopped":
      return event.type === "start"
        ? launch(state.run + 1, 0, policy)
        : stay(state);
    case "starting":
      switch (event.type) {
        case "spawned":
          if (state.phase === "handshaking") return stay(state);
          return {
            state: { ...state, phase: "handshaking" },
            commands: [
              { type: "initialize" },
              {
                type: "arm",
                run: state.run,
                deadline: "handshake",
                ms: policy.handshakeMs,
              },
            ],
          };
        case "ready":
          return stay({
            state: "running",
            run: state.run,
            crashes: state.crashes,
            since: event.at,
          });
        case "spawn-failed":
        case "exited":
          return crash(state.run, state.crashes + 1, policy, false);
        case "timer":
        case "broke-protocol":
          return crash(state.run, state.crashes + 1, policy, true);
        case "stop":
          return {
            state: { state: "stopping", run: state.run },
            commands: [{ type: "kill" }],
          };
        default:
          return stay(state);
      }
    case "running":
      switch (event.type) {
        case "exited":
        case "broke-protocol":
          return crash(
            state.run,
            crashCount(state.crashes, state.since, event.at, policy.stableMs),
            policy,
            event.type === "broke-protocol",
          );
        case "stop":
          return {
            state: { state: "stopping", run: state.run },
            commands: [
              { type: "shutdown" },
              {
                type: "arm",
                run: state.run,
                deadline: "grace",
                ms: policy.graceMs,
              },
            ],
          };
        default:
          return stay(state);
      }
    case "stopping":
      switch (event.type) {
        case "exited":
        case "spawn-failed":
        case "killed":
          return stay({
            state: "stopped",
            run: state.run,
            reason: "requested",
          });
        case "timer":
          return { state, commands: [{ type: "kill" }] };
        default:
          return stay(state);
      }
    case "crashed":
      switch (event.type) {
        case "timer":
          return launch(state.run + 1, state.crashes, policy);
        case "stop":
          return stay({
            state: "stopped",
            run: state.run,
            reason: "requested",
          });
        default:
          return stay(state);
      }
  }
}
