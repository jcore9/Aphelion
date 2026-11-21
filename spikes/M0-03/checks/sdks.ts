// SDK compatibility checks for M0-03. Throwaway spike code; never merged.
// bun checks/sdks.ts            run every check, print PASS/FAIL
// (the compiled binary runs the same checks: ./bin/sdks)
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import * as age from "age-encryption";
import sdk from "@1password/sdk";
import { BitwardenClient } from "@bitwarden/sdk-napi";

const compiled = import.meta.path.startsWith("/$bunfs");

function mcpServer() {
  const s = new McpServer({ name: "probe", version: "0.0.0" });
  s.registerTool("echo", { inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: "text", text: `echo:${text}` }],
  }));
  return s;
}

if (process.argv.includes("--mcp-stdio-server")) {
  await mcpServer().connect(new StdioServerTransport());
} else {
  const results: Array<[string, boolean, string]> = [];
  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      results.push([name, true, await fn()]);
    } catch (e) {
      results.push([name, false, (e as Error).message.slice(0, 160)]);
    }
  };

  await check("mcp stdio", async () => {
    const c = new Client({ name: "probe-client", version: "0.0.0" });
    const args = compiled ? ["--mcp-stdio-server"] : [import.meta.path, "--mcp-stdio-server"];
    await c.connect(new StdioClientTransport({ command: process.execPath, args }));
    const r = await c.callTool({ name: "echo", arguments: { text: "a" } });
    await c.close();
    return JSON.stringify(r.content);
  });

  await check("mcp streamable http", async () => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await mcpServer().connect(transport);
    const http = createServer((req, res) => transport.handleRequest(req, res));
    await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
    const port = (http.address() as { port: number }).port;
    const c = new Client({ name: "probe-client", version: "0.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const r = await c.callTool({ name: "echo", arguments: { text: "b" } });
    await c.close();
    http.close();
    return JSON.stringify(r.content);
  });

  await check("age-encryption", async () => {
    const id = await age.generateIdentity();
    const e = new age.Encrypter();
    e.addRecipient(await age.identityToRecipient(id));
    const ct = await e.encrypt("canary-value");
    const d = new age.Decrypter();
    d.addIdentity(id);
    const pt = await d.decrypt(ct, "text");
    if (pt !== "canary-value") throw new Error("roundtrip mismatch");
    return `roundtrip ok, ${ct.length} bytes`;
  });

  // A fake token: success means the SDK's WASM core loaded and rejected it.
  await check("1password sdk", async () => {
    try {
      await sdk.createClient({ auth: "ops_" + "x".repeat(40), integrationName: "aphelion-spike", integrationVersion: "0.0.0" });
      return "unexpected: fake token accepted";
    } catch (e) {
      const m = String((e as Error).message ?? e);
      if (/cannot find module|failed to load|wasm.*(compile|instantiate)/i.test(m)) throw e;
      return `core loaded, rejected fake token: ${m.slice(0, 80)}`;
    }
  });

  await check("bitwarden sdk-napi", async () => {
    const c = new BitwardenClient();
    try {
      await c.auth().loginAccessToken("0.00000000-0000-0000-0000-000000000000.fake:fake");
      return "unexpected: fake token accepted";
    } catch (e) {
      const m = String((e as Error).message ?? e);
      return `native addon loaded, rejected fake token: ${m.slice(0, 80)}`;
    }
  });

  for (const [name, ok, detail] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(22)} ${detail}`);
  console.log(`runtime: bun ${Bun.version}${compiled ? " (compiled binary)" : ""}`);
  process.exit(results.every((r) => r[1]) ? 0 : 1);
}
