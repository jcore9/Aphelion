export type StopReason = "requested" | "crashed too often";

export type LifecycleState =
  | { readonly state: "installed"; readonly run: number }
  | {
      readonly state: "starting";
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

export type LifecycleEvent =
  | { readonly type: "start" }
  | { readonly type: "stop" }
  | { readonly type: "spawned"; readonly run: number }
  | { readonly type: "spawn-failed"; readonly run: number }
  | { readonly type: "ready"; readonly run: number; readonly at: number }
  | { readonly type: "broke-protocol"; readonly run: number }
  | { readonly type: "exited"; readonly run: number; readonly at: number }
  | { readonly type: "killed" }
  | { readonly type: "timer"; readonly run: number };

export type LifecycleCommand =
  | { readonly type: "spawn"; readonly run: number }
  | { readonly type: "initialize" }
  | { readonly type: "shutdown" }
  | { readonly type: "kill" }
  | { readonly type: "arm"; readonly run: number; readonly ms: number };

export interface RestartPolicy {
  readonly handshakeMs: number;
  readonly graceMs: number;
  readonly firstRetryMs: number;
  readonly maxRetryMs: number;
  readonly maxCrashes: number;
  readonly stableMs: number;
}

export const defaultRestartPolicy: RestartPolicy = {
  handshakeMs: 10_000,
  graceMs: 5_000,
  firstRetryMs: 1_000,
  maxRetryMs: 60_000,
  maxCrashes: 5,
  stableMs: 60_000,
};

export interface Step {
  readonly state: LifecycleState;
  readonly commands: readonly LifecycleCommand[];
}

export const installed: LifecycleState = { state: "installed", run: 0 };

export function retryDelay(crashes: number, policy: RestartPolicy): number {
  return Math.min(policy.firstRetryMs * 2 ** (crashes - 1), policy.maxRetryMs);
}

const stay = (state: LifecycleState): Step => ({ state, commands: [] });

function launch(run: number, crashes: number, policy: RestartPolicy): Step {
  return {
    state: { state: "starting", run, crashes },
    commands: [
      { type: "spawn", run },
      { type: "arm", run, ms: policy.handshakeMs },
    ],
  };
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
    commands: [...kill, { type: "arm", run, ms: retryInMs }],
  };
}

const ofThisRun = (state: LifecycleState, event: LifecycleEvent) =>
  !("run" in event) || event.run === state.run;

export function step(
  state: LifecycleState,
  event: LifecycleEvent,
  policy: RestartPolicy,
): Step {
  if (!ofThisRun(state, event)) return stay(state);
  switch (state.state) {
    case "installed":
    case "stopped":
      return event.type === "start"
        ? launch(state.run + 1, 0, policy)
        : stay(state);
    case "starting":
      switch (event.type) {
        case "spawned":
          return { state, commands: [{ type: "initialize" }] };
        case "ready":
          return stay({ ...state, state: "running", since: event.at });
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
        case "exited": {
          const stable = event.at - state.since >= policy.stableMs;
          return crash(
            state.run,
            stable ? 1 : state.crashes + 1,
            policy,
            false,
          );
        }
        case "broke-protocol":
          return crash(state.run, state.crashes + 1, policy, true);
        case "stop":
          return {
            state: { state: "stopping", run: state.run },
            commands: [
              { type: "shutdown" },
              { type: "arm", run: state.run, ms: policy.graceMs },
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
