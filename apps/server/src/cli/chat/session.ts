import {
  commandId,
  encodeFrame,
  maxPromptLength,
  parseServerFrame,
  type ClientFrame,
  type CommandFrame,
  type Cursor,
  type ServerFrame,
} from "@aphelion/protocol";
import { createRenderer } from "./render";

export interface SocketEvents {
  readonly message: (text: string) => void;
  readonly close: (code: number) => void;
}

export interface ChatSocket {
  readonly send: (text: string) => void;
  readonly close: () => void;
}

export class Unauthorized extends Error {}

export interface ChatHost {
  readonly connect: (
    url: string,
    token: string,
    events: SocketEvents,
  ) => Promise<ChatSocket>;
  readonly lines: AsyncIterable<string>;
  readonly onInterrupt: (handler: () => void) => () => void;
  readonly out: (text: string) => void;
  readonly err: (line: string) => void;
  readonly sleep: (millis: number) => Promise<void>;
  readonly random: () => number;
  readonly uuid: () => string;
}

export interface ChatOptions {
  readonly bot: string;
  readonly url: string;
  readonly token: string;
  readonly cursor: Cursor | null;
  readonly saveCursor: (cursor: Cursor) => void;
  readonly signal?: AbortSignal;
}

const firstDelayMillis = 250;
const longestDelayMillis = 5_000;
const historyFailureLimit = 5;

export const backoff = (attempt: number, random: () => number) =>
  Math.round(
    Math.min(longestDelayMillis, firstDelayMillis * 2 ** attempt) *
      (0.8 + 0.4 * random()),
  );

export const messages = {
  greeting: (bot: string) =>
    `Connected to ${bot}. Type a message and press Enter. Ctrl-C cancels the turn, Ctrl-D leaves.`,
  lost: "aphelion: lost the connection to the server, trying again",
  back: "aphelion: connected again",
  refused:
    "aphelion: the device token was refused; add a device again with sudo aphelion device add",
  rejected:
    "aphelion: the server refused a frame this client sent; check that the client and the server are the same version",
  history: "aphelion: the server can't read its history; try again later",
  unreadable: "aphelion: the server sent a frame this client can't read",
  tooLong: "aphelion: that message is too long to send",
  restored: "the server's history was restored; continuing from now",
  cursorFile: "aphelion: couldn't save the cursor file",
} as const;

type Ended =
  | { readonly kind: "closed"; readonly code: number }
  | { readonly kind: "refused" }
  | { readonly kind: "unreachable" };

export const runChat = (options: ChatOptions, host: ChatHost) =>
  new Promise<number>((resolve) => {
    const view = createRenderer({ out: host.out, err: host.err });
    const pending = new Map<string, CommandFrame>();
    const endedTurns = new Set<string>();
    let cursor = options.cursor;
    let socket: ChatSocket | undefined;
    let generation = 0;
    let ready = false;
    let announced = false;
    let outage = false;
    let ending = false;
    let inputDone = false;
    let activeTurn: string | null = null;
    let cancelWanted = false;
    let cancelSent = false;
    let attempt = 0;
    let historyFailures = 0;
    let cursorFileBroken = false;

    const isEnding = () => ending;

    const send = (frame: ClientFrame) => {
      socket?.send(encodeFrame(frame));
    };

    const stopListening = host.onInterrupt(() => {
      interrupt();
    });

    const finish = (code: number) => {
      if (ending) return;
      ending = true;
      stopListening();
      options.signal?.removeEventListener("abort", onAbort);
      socket?.close();
      resolve(code);
    };

    const onAbort = () => {
      finish(0);
    };

    const fail = (message: string) => {
      view.status(message);
      finish(1);
    };

    const idle = () => activeTurn === null && pending.size === 0;

    const settle = () => {
      if (idle()) {
        cancelWanted = false;
        cancelSent = false;
        if (inputDone) finish(0);
      }
    };

    const sendCancel = () => {
      if (activeTurn === null || cancelSent) return;
      cancelSent = true;
      send({
        v: 1,
        type: "command",
        id: commandId.parse(host.uuid()),
        name: "bot.cancel",
        payload: { bot: options.bot, turn: activeTurn },
      });
    };

    function interrupt() {
      if (ending) return;
      if (!ready || idle() || cancelWanted) {
        finish(0);
        return;
      }
      cancelWanted = true;
      sendCancel();
    }

    const markReady = () => {
      if (ready) return;
      ready = true;
      if (!announced) {
        announced = true;
        view.info(messages.greeting(options.bot));
      } else if (outage) {
        view.status(messages.back);
      }
      outage = false;
      for (const frame of pending.values()) send(frame);
      if (cancelWanted) sendCancel();
    };

    const advance = (seq: number) => {
      if (cursor === null) return;
      cursor = { stream: cursor.stream, seq };
      try {
        options.saveCursor(cursor);
      } catch {
        if (!cursorFileBroken) {
          cursorFileBroken = true;
          view.status(messages.cursorFile);
        }
      }
    };

    const onFrame = (frame: ServerFrame) => {
      attempt = 0;
      historyFailures = 0;
      switch (frame.type) {
        case "resync":
          if (cursor !== null) view.notice(messages.restored);
          cursor = frame.cursor;
          try {
            options.saveCursor(cursor);
          } catch {
            view.status(messages.cursorFile);
          }
          send({ v: 1, type: "resume", cursor });
          markReady();
          return;
        case "event": {
          if (cursor === null || frame.seq <= cursor.seq) return;
          advance(frame.seq);
          if (frame.name === "notice") {
            view.notice(frame.payload.message);
            return;
          }
          const { bot, turn, event } = frame.payload;
          if (bot !== options.bot) return;
          view.event(event);
          if (event.type === "turn.end" && turn !== null) {
            endedTurns.add(turn);
            if (turn === activeTurn) {
              activeTurn = null;
              settle();
            }
          }
          return;
        }
        case "result":
          if (frame.name !== "bot.prompt" || !pending.delete(frame.id)) return;
          if (!endedTurns.has(frame.result.turn)) {
            activeTurn = frame.result.turn;
            if (cancelWanted) sendCancel();
          }
          settle();
          return;
        case "error":
          pending.delete(frame.id ?? "");
          view.status(`[error] ${frame.message}`);
          settle();
          return;
      }
    };

    const onMessage = (text: string) => {
      const parsed = parseServerFrame(text);
      if (parsed.ok) onFrame(parsed.frame);
      else view.status(messages.unreadable);
    };

    const attemptOnce = () =>
      new Promise<Ended>((done) => {
        const mine = (generation += 1);
        host
          .connect(options.url, options.token, {
            message: (text) => {
              if (mine === generation) onMessage(text);
            },
            close: (code) => {
              if (mine !== generation) return;
              ready = false;
              socket = undefined;
              done({ kind: "closed", code });
            },
          })
          .then(
            (opened) => {
              if (mine !== generation || isEnding()) {
                opened.close();
                return;
              }
              socket = opened;
              send({ v: 1, type: "resume", cursor });
              if (cursor !== null) markReady();
            },
            (error: unknown) => {
              done(
                error instanceof Unauthorized
                  ? { kind: "refused" }
                  : { kind: "unreachable" },
              );
            },
          );
      });

    const reconnecting = async () => {
      while (!ending) {
        const ended = await attemptOnce();
        if (isEnding()) return;
        if (
          ended.kind === "refused" ||
          (ended.kind === "closed" && ended.code === 1008)
        ) {
          fail(messages.refused);
          return;
        }
        if (ended.kind === "closed" && ended.code === 1007) {
          fail(messages.rejected);
          return;
        }
        if (ended.kind === "closed" && ended.code === 1011) {
          historyFailures += 1;
          if (historyFailures >= historyFailureLimit) {
            fail(messages.history);
            return;
          }
        }
        if (!outage) {
          outage = true;
          view.status(messages.lost);
        }
        await host.sleep(backoff(attempt, host.random));
        attempt += 1;
      }
    };

    const submit = (text: string) => {
      if (text.length > maxPromptLength) {
        view.status(messages.tooLong);
        return;
      }
      const frame: CommandFrame = {
        v: 1,
        type: "command",
        id: commandId.parse(host.uuid()),
        name: "bot.prompt",
        payload: { bot: options.bot, text },
      };
      pending.set(frame.id, frame);
      if (ready) send(frame);
    };

    const reading = async () => {
      try {
        for await (const line of host.lines) {
          if (ending) return;
          if (line.trim() !== "") submit(line);
        }
      } finally {
        inputDone = true;
        settle();
      }
    };

    if (options.signal?.aborted) {
      finish(0);
      return;
    }
    options.signal?.addEventListener("abort", onAbort);
    void reconnecting();
    void reading();
  });
