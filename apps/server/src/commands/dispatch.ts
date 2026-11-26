import {
  serverFrame,
  version,
  type CommandFailure,
  type CommandFrame,
  type CommandId,
  type ServerFrame,
} from "@aphelion/protocol";
import { turnId, type TurnId } from "@aphelion/plugin-sdk";
import { Effect } from "effect";
import type { StartedTurn, TurnOutcome } from "../bots/manager";
import type { DeviceId } from "../devices";
import { clientEvent, type EventLog } from "../history";
import type { Logger } from "../log";
import type { CommandLedger, Outcome } from "./ledger";

export interface BotCommands {
  readonly startTurn: (bot: string, text: string) => Effect.Effect<StartedTurn>;
  readonly cancelTurn: (bot: string, turn: TurnId) => Effect.Effect<void>;
}

export interface CommandServices {
  readonly bots: BotCommands | undefined;
  readonly ledger: CommandLedger;
  readonly logger: Logger;
}

export interface CommandContext extends CommandServices {
  readonly history: EventLog;
}

export const failureMessages = {
  "bot-not-running": "the bot isn't running, so it can't take a prompt",
  "bot-busy": "the bot is busy with another turn",
  "prompt-too-long": "the prompt is longer than 256 KiB",
  "prompt-refused": "the bot refused the prompt",
  "bot-not-responding": "the bot didn't answer in time",
  interrupted:
    "the server stopped before it finished this command, so it didn't run again; check the history to see whether it took effect before you send a new command",
  "storage-failed":
    "the server ran this command but could not save its result; check the history to see whether it took effect before you send a new command",
  "device-revoked": "this device's token is no longer valid",
  "rate-limited": "this device sent too many commands; wait and try again",
  "id-reused": "this command id already ran a different command",
  internal: "the server could not run the command",
} as const satisfies Record<CommandFailure, string>;

const refusals = {
  "not-running": "bot-not-running",
  busy: "bot-busy",
  "too-long": "prompt-too-long",
  ended: "prompt-refused",
  refused: "prompt-refused",
} as const satisfies Record<Exclude<TurnOutcome, "accepted">, CommandFailure>;

const fail = (code: CommandFailure): Outcome => ({ ok: false, code });

const reply = (
  id: CommandId,
  name: CommandFrame["name"],
  outcome: Outcome,
): ServerFrame =>
  serverFrame.parse(
    outcome.ok
      ? { v: version, type: "result", id, name, result: outcome.result }
      : {
          v: version,
          type: "error",
          id,
          code: outcome.code,
          message: failureMessages[outcome.code],
        },
  );

const execute = (
  { bots, ledger, history, logger }: CommandContext,
  device: DeviceId,
  frame: CommandFrame,
): Effect.Effect<ServerFrame> => {
  const answer = (name: CommandFrame["name"], outcome: Outcome) =>
    reply(frame.id, name, outcome);
  const once = (apply: Effect.Effect<Outcome>) =>
    ledger.run({ device, id: frame.id, name: frame.name }, apply);

  switch (frame.name) {
    case "ping":
      return Effect.succeed(answer("ping", { ok: true, result: {} }));
    case "bot.prompt": {
      const { bot, text } = frame.payload;
      return once(
        bots === undefined
          ? Effect.succeed(fail("bot-not-running"))
          : bots
              .startTurn(bot, text)
              .pipe(
                Effect.map(({ turn, outcome }) =>
                  outcome === "accepted"
                    ? { ok: true, result: { turn } }
                    : fail(refusals[outcome]),
                ),
              ),
      ).pipe(Effect.map((outcome) => answer("bot.prompt", outcome)));
    }
    case "bot.cancel": {
      const { bot, turn } = frame.payload;
      return once(
        Effect.suspend(() =>
          bots === undefined
            ? Effect.succeed({ ok: true, result: {} })
            : bots
                .cancelTurn(bot, turnId.parse(turn))
                .pipe(Effect.as({ ok: true, result: {} })),
        ),
      ).pipe(Effect.map((outcome) => answer("bot.cancel", outcome)));
    }
    case "history.read": {
      const { bot, after = 0, limit } = frame.payload;
      return Effect.try(() => {
        const rows = history.readBot(bot, after, limit + 1);
        const shown = rows.slice(0, limit);
        return {
          ok: true,
          result: {
            events: shown.flatMap((saved) => clientEvent(saved) ?? []),
            next: shown.at(-1)?.position ?? after,
            more: rows.length > limit,
          },
        } satisfies Outcome;
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            logger.error("history.read could not read a saved event", {
              error:
                error.cause instanceof Error ? error.cause.name : "unknown",
            });
            return fail("internal");
          }),
        ),
        Effect.map((outcome) => answer("history.read", outcome)),
      );
    }
  }
};

export const dispatch = (
  context: CommandContext,
  device: DeviceId,
  frame: CommandFrame,
): Effect.Effect<ServerFrame> =>
  Effect.suspend(() => execute(context, device, frame)).pipe(
    Effect.catchCause(() =>
      Effect.sync(() => {
        context.logger.error(
          "a command failed in a way the server didn't expect",
          {
            command: frame.name,
          },
        );
        return reply(frame.id, frame.name, fail("internal"));
      }),
    ),
  );
