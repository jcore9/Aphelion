// Drives `codex app-server` over stdio JSON-RPC and logs what happens.
// Spike code for M0-17. Never merged.
//
// bun app-server-probe.ts [--cwd DIR] [--prompt TEXT] [--policy JSON] [--sandbox MODE]
//   [--reviewer user|auto_review] [--resume THREAD_ID] [--ephemeral] [--deny] [--account]
//   [--requirements] [--hooks] [--turn-policy JSON] [--turn-sandbox JSON] [--model M] -- CMD [ARGS...]
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const opts = sep >= 0 ? argv.slice(0, sep) : argv;
const cmd = sep >= 0 ? argv.slice(sep + 1) : ["codex", "app-server"];
const opt = (name: string) => {
  const i = opts.indexOf(name);
  return i >= 0 ? opts[i + 1] : undefined;
};
const flag = (name: string) => opts.includes(name);
const cwd = opt("--cwd") ?? process.cwd();
const promptText = opt("--prompt");
const policy = opt("--policy") ? JSON.parse(opt("--policy")!) : undefined;
const sandbox = opt("--sandbox");
const reviewer = opt("--reviewer");
const resumeId = opt("--resume");
const model = opt("--model");
const deny = flag("--deny");

const t0 = Date.now();
const log = (event: string, data?: unknown) =>
  console.log(JSON.stringify({ ms: Date.now() - t0, event, data }));
const redact = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v ?? null, (k, x) => (k === "email" || k === "userId" || k === "accountId" || k === "chatgptAccountId" ? (x ? "<redacted>" : x) : x)));

const child = spawn(cmd[0], cmd.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
child.stderr.on("data", (d) => process.stderr.write(`[codex stderr] ${d}`));
child.on("exit", (code, sig) => log("child_exit", { code, sig }));

let nextId = 1;
const pending = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();
const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + "\n");
const request = (method: string, params: unknown) =>
  new Promise<{ result?: any; error?: any }>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });

let turnDone: (() => void) | undefined;
const counts = new Map<string, number>();
const approvals: unknown[] = [];

const answerApproval = (method: string, params: any) => {
  if (method === "item/commandExecution/requestApproval") return { decision: deny ? "decline" : "accept" };
  if (method === "item/fileChange/requestApproval") return { decision: deny ? "decline" : "accept" };
  if (method === "item/permissions/requestApproval") return deny ? { permissions: {}, scope: "turn" } : { permissions: params.permissions, scope: "turn" };
  if (method === "mcpServer/elicitation/request") return { action: deny ? "decline" : "accept", content: {} };
  if (method === "execCommandApproval" || method === "applyPatchApproval") return { decision: deny ? "denied" : "approved" };
  return undefined;
};

createInterface({ input: child.stdout }).on("line", (line) => {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    log("non_json", line);
    return;
  }
  if (msg.id !== undefined && msg.method === undefined) {
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.id !== undefined && msg.method) {
    const answer = answerApproval(msg.method, msg.params);
    const p = msg.params ?? {};
    const summary = { method: msg.method, kind: p.kind, command: p.command, reason: p.reason, permissions: p.permissions, serverName: p.serverName, message: p.message, decisions: p.availableDecisions };
    approvals.push(summary);
    log("server_request", summary);
    if (answer) {
      log("answer", answer);
      send({ id: msg.id, result: answer });
    } else {
      send({ id: msg.id, error: { code: -32601, message: "probe does not handle " + msg.method } });
    }
    return;
  }
  const m: string = msg.method;
  counts.set(m, (counts.get(m) ?? 0) + 1);
  const p = msg.params ?? {};
  if (m === "item/started" || m === "item/completed") {
    const it = p.item ?? {};
    const brief: any = { type: it.type, status: it.status };
    if (it.type === "commandExecution") Object.assign(brief, { command: it.command, exitCode: it.exitCode, out: typeof it.aggregatedOutput === "string" ? it.aggregatedOutput.slice(0, 200) : undefined });
    if (it.type === "fileChange") brief.changes = it.changes?.map((c: any) => ({ path: c.path, kind: c.kind }));
    if (it.type === "mcpToolCall") Object.assign(brief, { server: it.server, tool: it.tool, error: it.error });
    if (it.type === "webSearch") brief.query = it.query;
    if (it.type === "agentMessage") brief.text = it.text;
    log(m, brief);
  } else if (m === "turn/completed") {
    log(m, { status: p.turn?.status, error: p.turn?.error });
    turnDone?.();
  } else if (m === "thread/tokenUsage/updated" || m === "account/rateLimits/updated") {
    log(m, redact(p));
  } else if (m === "error" || m === "warning" || m === "configWarning" || m === "deprecationNotice" || m === "hook/started" || m === "hook/completed" || m === "serverRequest/resolved" || m === "item/autoApprovalReview/started" || m === "item/autoApprovalReview/completed") {
    log(m, p);
  }
});

const exit = (code: number) => {
  log("notification_counts", Object.fromEntries(counts));
  log("approval_requests_total", approvals.length);
  child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
};

const init = await request("initialize", {
  clientInfo: { name: "aphelion_spike", title: "Aphelion M0-17 spike", version: "0.0.0" },
  capabilities: { experimentalApi: true, requestAttestation: false },
});
if (init.error) {
  log("initialize_error", init.error);
  exit(1);
}
log("initialize", { userAgent: init.result.userAgent, platformOs: init.result.platformOs });
send({ method: "initialized" });

if (flag("--account")) {
  const acct = await request("account/read", { refreshToken: false });
  log("account/read", redact(acct.result ?? acct.error));
  const rl = await request("account/rateLimits/read", undefined);
  log("account/rateLimits/read", redact(rl.result ?? rl.error));
}
if (flag("--hooks")) {
  const h = await request("hooks/list", { cwds: [cwd] });
  log("hooks/list", h.result ?? h.error);
}
if (flag("--requirements")) {
  const r = await request("configRequirements/read", undefined);
  log("configRequirements/read", r.result ?? r.error);
}

if (promptText || resumeId) {
  const threadParams: any = { cwd };
  if (policy !== undefined) threadParams.approvalPolicy = policy;
  if (sandbox) threadParams.sandbox = sandbox;
  if (reviewer) threadParams.approvalsReviewer = reviewer;
  if (model) threadParams.model = model;
  if (flag("--ephemeral")) threadParams.ephemeral = true;
  const started = resumeId
    ? await request("thread/resume", { threadId: resumeId, ...threadParams })
    : await request("thread/start", threadParams);
  if (started.error) {
    log(resumeId ? "thread/resume_error" : "thread/start_error", started.error);
    exit(2);
  } else {
    const th = started.result;
    log(resumeId ? "thread/resume" : "thread/start", {
      threadId: th.thread?.id,
      approvalPolicy: th.approvalPolicy,
      approvalsReviewer: th.approvalsReviewer,
      sandbox: th.sandbox,
      model: th.model,
      turns: th.thread?.turns?.length,
    });
    if (promptText) {
      const done = new Promise<void>((r) => (turnDone = r));
      const turnParams: any = { threadId: th.thread.id, input: [{ type: "text", text: promptText, text_elements: [] }] };
      if (opt("--turn-policy")) turnParams.approvalPolicy = JSON.parse(opt("--turn-policy")!);
      if (opt("--turn-sandbox")) turnParams.sandboxPolicy = JSON.parse(opt("--turn-sandbox")!);
      const turn = await request("turn/start", turnParams);
      if (turn.error) {
        log("turn/start_error", turn.error);
        exit(3);
      }
      await Promise.race([done, new Promise((r) => setTimeout(r, Number(opt("--timeout") ?? 180000)))]);
    }
    if (flag("--account")) {
      const rl = await request("account/rateLimits/read", undefined);
      log("account/rateLimits/read_after", redact(rl.result ?? rl.error));
    }
    exit(0);
  }
} else {
  exit(0);
}
