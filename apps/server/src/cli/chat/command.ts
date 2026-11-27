import { readFile, stat } from "node:fs/promises";
import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { z } from "zod";
import { usage } from "../failure";
import { failed } from "../failure";
import {
  checkedArgument,
  checkedFlag,
  operands,
  optionalFlag,
  options,
  textFlag,
  type Handler,
} from "../flags";
import { CliIo } from "../io";
import { hint } from "../output";
import { fileCursorStore } from "./cursor-file";
import { processEnvironment } from "./process-environment";
import { runChat, type ChatHost } from "./session";

export interface ChatEnvironment {
  readonly host: ChatHost;
  readonly isTerminal: boolean;
  readonly promptToken: () => Promise<string | null>;
  readonly release?: () => void;
}

export interface ChatCommandOptions {
  readonly bot: string;
  readonly url: string;
  readonly tokenFile: string | undefined;
  readonly cursorFile: string | undefined;
}

export const defaultUrl = "ws://127.0.0.1:7400/ws";

const schemes: Readonly<Record<string, string>> = {
  "http:": "ws:",
  "https:": "wss:",
  "ws:": "ws:",
  "wss:": "wss:",
};

export const normalizeUrl = (text: string) => {
  const url = new URL(text);
  const scheme = schemes[url.protocol];
  if (
    scheme === undefined ||
    (url.pathname !== "/" && url.pathname !== "/ws") ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("not a server address");
  }
  url.protocol = scheme;
  url.pathname = "/ws";
  return url.toString();
};

const urlText = z
  .string()
  .refine(
    (text) => {
      try {
        normalizeUrl(text);
        return true;
      } catch {
        return false;
      }
    },
    { error: "must be an http, https, ws or wss address with no path or /ws" },
  )
  .transform(normalizeUrl);

const botText = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, {
  error: "must be lower case letters, digits and hyphens, like chief",
});

const deviceToken = /^aph_dev_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/;

const refuse = (message: string) =>
  Effect.gen(function* () {
    const io = yield* CliIo;
    yield* io.err(`aphelion: ${message}`);
    yield* io.err(hint);
    return yield* usage;
  });

const checkToken = (text: string, complaint: string) =>
  deviceToken.test(text) ? Effect.succeed(text) : refuse(complaint);

const tokenFromFile = (path: string) =>
  Effect.gen(function* () {
    const mode = yield* Effect.tryPromise(() => stat(path)).pipe(
      Effect.map((info) => info.mode),
      Effect.catch(() => refuse("can't read the token file")),
    );
    if ((mode & 0o077) !== 0) {
      return yield* refuse(
        "the token file can be read by other users; run chmod 600 on it",
      );
    }
    const text = yield* Effect.tryPromise(() => readFile(path, "utf8")).pipe(
      Effect.catch(() => refuse("can't read the token file")),
    );
    return yield* checkToken(
      text.trim(),
      "the token file doesn't hold a device token",
    );
  });

const resolveToken = (
  tokenFile: string | undefined,
  environment: ChatEnvironment,
) => {
  if (tokenFile !== undefined) return tokenFromFile(tokenFile);
  if (!environment.isTerminal) {
    return refuse(
      "no device token. Pass --token-file PATH, or run in a terminal to be asked for it.",
    );
  }
  return Effect.promise(environment.promptToken).pipe(
    Effect.flatMap((text) =>
      text === null
        ? Effect.succeed(null)
        : checkToken(text, "that isn't a device token"),
    ),
  );
};

export const chatWith = (
  config: ChatCommandOptions,
  environment: ChatEnvironment,
) =>
  Effect.gen(function* () {
    const token = yield* resolveToken(config.tokenFile, environment);
    if (token === null) {
      const io = yield* CliIo;
      yield* io.err("aphelion: no device token entered");
      return;
    }
    const store =
      config.cursorFile === undefined
        ? undefined
        : fileCursorStore(config.cursorFile);
    const code = yield* Effect.tryPromise({
      try: (signal) =>
        runChat(
          {
            bot: config.bot,
            url: config.url,
            token,
            cursor: store?.load() ?? null,
            saveCursor: (position) => {
              store?.save(position);
            },
            signal,
          },
          environment.host,
        ),
      catch: () => new Error("the chat stopped unexpectedly"),
    }).pipe(Effect.ensuring(Effect.sync(() => environment.release?.())));
    if (code !== 0) return yield* failed;
  });

export const chat = (config: ChatCommandOptions) =>
  chatWith(config, processEnvironment());

export const chatCommand = (handler: Handler<ChatCommandOptions>) =>
  Command.make(
    "chat",
    {
      bot: checkedArgument(operands.chat, "bot name", botText),
      url: checkedFlag(options.url, urlText).pipe(
        Flag.withDefault(defaultUrl),
        Flag.withDescription(
          `The server's address, ws://HOST:PORT/ws or http://HOST:PORT (default ${defaultUrl})`,
        ),
      ),
      tokenFile: optionalFlag(
        textFlag(options.tokenFile).pipe(
          Flag.withDescription(
            "A file that holds the device token and that only you can read. Without it, a terminal asks for the token",
          ),
        ),
      ),
      cursorFile: optionalFlag(
        textFlag(options.cursorFile).pipe(
          Flag.withDescription(
            "A file that keeps the last event shown, so a new run carries on from it",
          ),
        ),
      ),
    },
    handler,
  ).pipe(
    Command.withDescription(
      "Chat with a bot in plain lines. Shows streaming text and tool events, and after a dropped connection shows the events it missed.",
    ),
  );
