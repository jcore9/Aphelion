import { describe, expect, test } from "vitest";
import {
  commandId,
  encodeFrame,
  parseClientFrame,
  parseServerFrame,
  streamId,
  type ClientFrame,
  type ServerFrame,
} from "./index";

const id = commandId.parse("0b6f4c2e-7d1a-4a57-9a0c-3f5e8d2b1c90");
const cursor = { stream: streamId.parse("s1"), seq: 4 };

const clientFrames: ClientFrame[] = [
  { v: 1, type: "command", id, name: "ping", payload: {} },
  { v: 1, type: "resume", cursor },
  { v: 1, type: "resume", cursor: null },
];

const event: ServerFrame = {
  v: 1,
  type: "event",
  seq: 5,
  name: "notice",
  payload: { message: "hi" },
};

const serverFrames: ServerFrame[] = [
  { v: 1, type: "result", id, name: "ping", result: {} },
  event,
  { v: 1, type: "resync", cursor },
  { v: 1, type: "error", code: "malformed", message: "bad", id },
  { v: 1, type: "error", code: "unsupported-version", message: "bad" },
];

describe("parsing frames", () => {
  test.each(clientFrames)("accepts the client frame %j", (frame) => {
    expect(parseClientFrame(encodeFrame(frame))).toEqual({ ok: true, frame });
  });

  test.each(serverFrames)("accepts the server frame %j", (frame) => {
    expect(parseServerFrame(encodeFrame(frame))).toEqual({ ok: true, frame });
  });

  test.each([
    ["text that is not JSON", "{"],
    ["a JSON value that is not an object", "[]"],
    ["a frame with no v", `{"type":"resume","cursor":null}`],
    ["an unknown frame type", `{"v":1,"type":"hello"}`],
    ["a server frame sent by a client", encodeFrame(event)],
    ["an unknown field", `{"v":1,"type":"resume","cursor":null,"x":1}`],
    [
      "a command id with a space",
      `{"v":1,"type":"command","id":"a b","name":"ping","payload":{}}`,
    ],
    [
      "a negative cursor",
      `{"v":1,"type":"resume","cursor":{"stream":"s1","seq":-1}}`,
    ],
  ])("rejects %s as malformed", (_, text) => {
    const parsed = parseClientFrame(text);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error.code).toBe("malformed");
  });

  test("names the command id when a command is malformed, so the client can match the error", () => {
    const parsed = parseClientFrame(
      `{"v":1,"type":"command","id":"${id}","name":"no-such-command","payload":{}}`,
    );
    expect(parsed).toMatchObject({
      ok: false,
      error: { code: "malformed", id },
    });
  });

  test("rejects a payload that doesn't match its command", () => {
    const parsed = parseClientFrame(
      `{"v":1,"type":"command","id":"${id}","name":"ping","payload":{"x":1}}`,
    );
    expect(parsed).toMatchObject({
      ok: false,
      error: { code: "malformed", id },
    });
  });

  test.each([2, 0, "1", null])(
    "rejects v %j as unsupported, on both sides",
    (v) => {
      const text = JSON.stringify({ ...clientFrames[0], v });
      for (const parsed of [parseClientFrame(text), parseServerFrame(text)]) {
        expect(parsed).toMatchObject({
          ok: false,
          error: { code: "unsupported-version" },
        });
      }
    },
  );

  test("rejects an event with sequence number 0, which no event has", () => {
    const parsed = parseServerFrame(
      `{"v":1,"type":"event","seq":0,"name":"notice","payload":{"message":"hi"}}`,
    );
    expect(parsed).toMatchObject({ ok: false, error: { code: "malformed" } });
  });
});
