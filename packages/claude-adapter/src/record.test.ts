import { denyAll } from "@aphelion/plugin-sdk";
import { checkStream, runTurn } from "@aphelion/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { claudeAdapter } from "./adapter.ts";
import { recordingQuery } from "./record.ts";
import { scriptedQuery, sdk } from "./scripted-query.ts";

describe("recordingQuery", () => {
  it("keeps every SDK message in order and passes it on unchanged", async () => {
    const messages = [sdk.init(), sdk.text("Hi"), sdk.result()];
    const scripted = scriptedQuery([messages.map((send) => ({ send }))]);
    const recorded: unknown[] = [];
    const run = await runTurn(
      claudeAdapter({
        query: recordingQuery(scripted.query, (message) => {
          recorded.push(message);
        }),
        env: {},
        rule: denyAll,
      }),
    );

    expect(recorded).toEqual(messages);
    expect(run.events.map(({ event }) => event.type)).toEqual([
      "session",
      "text.delta",
      "usage",
      "turn.end",
    ]);
    expect(checkStream(run.events)).toEqual([]);
  });
});
