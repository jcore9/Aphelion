import { createTestHost } from "@aphelion/plugin-sdk/testing";
import { expect, test } from "vitest";
import manifest from "../aphelion-plugin.json" with { type: "json" };
import plugin from "./plugin.ts";

test("logs each approval request once the owner grants the event", async () => {
  const host = createTestHost(manifest);
  host.setGrants([{ kind: "events", name: "approval.requested" }]);
  await host.start(plugin);
  await host.publish("approval.requested", { tool: "shell" });
  await host.stop();
  expect(host.logs).toEqual([
    "plugin started",
    'an approval was requested: {"tool":"shell"}',
  ]);
});

test("doesn't start when the owner hasn't granted the event", async () => {
  const host = createTestHost(manifest);
  await expect(host.start(plugin)).rejects.toMatchObject({ code: -32001 });
  await host.stop();
});
