import { readFileSync, readlinkSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

const attempt = (read) => {
  try {
    read();
    return "ok";
  } catch (error) {
    return error.code;
  }
};

let seq = 0;
let bot = "";
const event = (turn, body) => {
  seq += 1;
  send({ method: "event", params: { seq, turn, event: body } });
};

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize":
      bot = message.params.bot.id;
      send({ id: message.id, result: { api: "0.1.0", provider: "claude" } });
      break;
    case "turn.start": {
      const { turn } = message.params;
      send({ id: message.id, result: {} });
      const report = {
        bot,
        uid: process.getuid(),
        cwd: process.cwd(),
        env: process.env,
        runnerFd: attempt(() => readlinkSync(`/proc/${process.ppid}/fd/0`)),
        runnerEnviron: attempt(() =>
          readFileSync(`/proc/${process.ppid}/environ`),
        ),
      };
      event(null, { type: "session", ref: "contract-session-1" });
      event(turn, { type: "text.delta", text: JSON.stringify(report) });
      event(turn, { type: "turn.end", reason: "completed" });
      break;
    }
    case "shutdown":
      send({ id: message.id, result: {} });
      process.exit(0);
  }
}
