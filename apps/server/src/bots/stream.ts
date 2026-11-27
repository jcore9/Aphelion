import type {
  AdapterEnvelope,
  PermissionRequestId,
  StreamEvent,
  ToolCallId,
  TurnId,
} from "@aphelion/plugin-sdk";

export interface StreamTracker {
  readonly observe: (envelope: AdapterEnvelope) => void;
  readonly begin: (turn: TurnId) => void;
  readonly repair: () => AdapterEnvelope[];
  readonly last: () => number;
  readonly open: () => TurnId | undefined;
}

interface Ask {
  readonly turn: TurnId;
  readonly request: PermissionRequestId;
}

export function streamTracker(): StreamTracker {
  let seq = 0;
  let open: TurnId | undefined;
  const ended = new Set<TurnId>();
  const calls = new Map<ToolCallId, TurnId>();
  const asks = new Map<string, Ask>();
  const askKey = (turn: TurnId, request: PermissionRequestId) =>
    `${turn}\u0000${request}`;

  const begin = (turn: TurnId) => {
    if (!ended.has(turn)) open = turn;
  };

  const finish = (turn: TurnId) => {
    ended.add(turn);
    if (open === turn) open = undefined;
    for (const [key, ask] of asks) if (ask.turn === turn) asks.delete(key);
  };

  const observe = ({ seq: number, turn, event }: AdapterEnvelope) => {
    seq = number;
    if (turn === null) return;
    switch (event.type) {
      case "tool.end":
        calls.delete(event.call);
        return;
      case "turn.end":
        finish(turn);
        return;
      case "tool.start":
        calls.set(event.call, turn);
        break;
      case "permission.request":
        asks.set(askKey(turn, event.request), { turn, request: event.request });
        break;
      case "permission.decision":
        asks.delete(askKey(turn, event.request));
        break;
      default:
        break;
    }
    begin(turn);
  };

  const repair = () => {
    if (open === undefined && calls.size === 0 && asks.size === 0) return [];
    const repaired: AdapterEnvelope[] = [];
    const append = (turn: TurnId | null, event: StreamEvent) => {
      seq += 1;
      repaired.push({ seq, turn, event });
    };
    const turn = open;
    append(turn ?? null, { type: "error", code: "cli-exited" });
    for (const ask of asks.values()) {
      append(ask.turn, {
        type: "permission.decision",
        request: ask.request,
        decision: "deny",
        by: "default",
        reason: "shutdown",
      });
    }
    for (const [call, owner] of calls) {
      append(owner, { type: "tool.end", call, outcome: "cancelled" });
    }
    calls.clear();
    if (turn !== undefined) {
      append(turn, { type: "turn.end", reason: "error" });
      finish(turn);
    }
    asks.clear();
    return repaired;
  };

  return { observe, begin, repair, last: () => seq, open: () => open };
}
