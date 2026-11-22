// Minimal stdio MCP server with two tools, one marked read-only. Spike code for M0-17. Never merged.
import { createInterface } from "node:readline";
const send = (m: object) => process.stdout.write(JSON.stringify(m) + "\n");
const tools = [
  { name: "echo", description: "Echo text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "peek", description: "Return a constant. Read-only.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
];
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "0.0.0" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools } });
  if (m.method === "tools/call") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `${m.params.name}: ${JSON.stringify(m.params.arguments)}` }] } });
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
});
