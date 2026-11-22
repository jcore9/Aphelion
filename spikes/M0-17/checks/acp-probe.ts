// ACP probe: drives any ACP agent over stdio and logs what happens.
// Spike code for M0-01, M0-02, M0-03 and M0-17. Not production code; never merged.
//
// bun checks/acp-probe.ts --cwd DIR --prompt TEXT [--load SESSION_ID] [--deny] -- CMD [ARGS...]
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const opts = argv.slice(0, sep);
const cmd = argv.slice(sep + 1);
const opt = (name: string) => {
  const i = opts.indexOf(name);
  return i >= 0 ? opts[i + 1] : undefined;
};
const cwd = opt("--cwd") ?? process.cwd();
const promptText = opt("--prompt") ?? "Say hello in one word.";
const loadId = opt("--load");
const deny = opts.includes("--deny");
const mode = opt("--mode");

const log = (event: string, data: unknown) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), event, data }));

const child = spawn(cmd[0], cmd.slice(1), { cwd, stdio: ["pipe", "pipe", "inherit"], env: process.env });
const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
  Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
);

const updates = new Map<string, number>();
const app = acp
  .client({ name: "aphelion-acp-probe" })
  .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
    const p = ctx.params;
    log("permission_request", {
      tool: p.toolCall?.title,
      kind: p.toolCall?.kind,
      options: p.options.map((o) => `${o.kind}:${o.optionId}`),
    });
    const want = deny ? "reject_once" : "allow_once";
    const choice = p.options.find((o) => o.kind === want) ?? p.options[0];
    log("permission_answer", { optionId: choice.optionId, kind: choice.kind });
    return { outcome: { outcome: "selected", optionId: choice.optionId } };
  })
  .onNotification(acp.methods.client.session.update, (ctx) => {
    const u = ctx.params.update as { sessionUpdate: string; [k: string]: unknown };
    updates.set(u.sessionUpdate, (updates.get(u.sessionUpdate) ?? 0) + 1);
    if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update")
      log(u.sessionUpdate, { title: u.title, kind: u.kind, status: u.status });
    if (u.sessionUpdate === "agent_message_chunk") {
      const c = u.content as { type: string; text?: string };
      if (c.type === "text") process.stderr.write(c.text ?? "");
    }
    if (u.sessionUpdate === "usage_update") log("usage_update", u);
  });

const started = Date.now();
try {
  await app.connectWith(stream, async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "aphelion-acp-probe", version: "0.0.0" },
    });
    log("initialize", {
      agentInfo: init.agentInfo,
      protocolVersion: init.protocolVersion,
      loadSession: init.agentCapabilities?.loadSession,
      sessionCapabilities: init.agentCapabilities?.sessionCapabilities,
      authMethods: init.authMethods?.map((m) => ({ id: m.id, name: m.name })),
    });
    let sessionId: string;
    if (loadId) {
      await ctx.request(acp.methods.agent.session.load, { sessionId: loadId, cwd, mcpServers: [] });
      sessionId = loadId;
      log("session_loaded", { sessionId });
    } else {
      const s = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
      sessionId = s.sessionId;
      log("session_new", { sessionId, modes: s.modes?.availableModes?.map((m) => m.id), currentMode: s.modes?.currentModeId });
    }
    if (mode) {
      await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: mode });
      log("mode_set", { mode });
    }
    const r = await ctx.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: promptText }],
    });
    process.stderr.write("\n");
    log("prompt_done", { stopReason: r.stopReason, usage: (r as { usage?: unknown }).usage, ms: Date.now() - started });
  });
} catch (e) {
  log("error", { message: (e as Error).message, data: (e as { data?: unknown }).data });
  process.exitCode = 1;
} finally {
  log("update_counts", Object.fromEntries(updates));
  child.kill("SIGTERM");
}
