import { closeSync, readSync } from "node:fs";
import { chmod, lstat, readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { generateIdentity } from "age-encryption";
import { z } from "zod";
import { createLogger } from "../log";
import {
  LocalStoreRefusal,
  openLocalStore,
  validateBootstrapKey,
} from "./local-store";
import { parseSecretReference } from "./reference";
import { Secret } from "./secret";

const brokerUid = 10003;
const socketDirectory = "/run/aphelion-secrets";
const storeDirectory = "/var/lib/aphelion-secrets";
const maxRequestBytes = 64 * 1024;
const maxKeyBytes = 1024;
const requestSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("read"), ref: z.string() }),
  z.strictObject({
    op: z.literal("write"),
    ref: z.string(),
    value: z.string(),
  }),
]);

class BrokerRefusal extends Error {
  override name = "BrokerRefusal";

  constructor(
    readonly reason:
      | "The secrets broker takes no arguments except --new-key and --check-key"
      | "The bootstrap key is missing from standard input"
      | "The bootstrap key is longer than 1 KiB",
  ) {
    super(reason);
  }
}

const logger = createLogger({
  write: (line) => process.stderr.write(`${line}\n`),
});

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: Awaited<ReturnType<typeof openLocalStore>>,
): Promise<void> {
  response.setHeader("Connection", "close");
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "POST" || request.url !== "/v1/local") {
    response.writeHead(404).end();
    return;
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected request encoding");
    bytes += chunk.length;
    if (bytes > maxRequestBytes) {
      request.destroy();
      return;
    }
    chunks.push(chunk);
  }

  let input: unknown;
  try {
    input = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    response.writeHead(400).end();
    return;
  }
  const parsed = requestSchema.safeParse(input);
  const ref = parsed.success && parseSecretReference(parsed.data.ref);
  if (!parsed.success || !ref || !ref.ok || ref.reference.scheme !== "local") {
    response.writeHead(400).end();
    return;
  }

  if (parsed.data.op === "write") {
    const secret = Secret.make(parsed.data.value);
    try {
      await store.write(ref.reference.path, secret);
    } finally {
      secret.wipe();
    }
    response.writeHead(204).end();
    return;
  }

  const secret = await store.read(ref.reference.path);
  if (!secret) {
    response.writeHead(404).end();
    return;
  }
  try {
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(secret.reveal()));
  } finally {
    secret.wipe();
  }
}

function readBootstrapKey(): Secret {
  const buffer = Buffer.alloc(maxKeyBytes + 1);
  let length = 0;
  try {
    for (;;) {
      const read = readSync(0, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > maxKeyBytes) {
        throw new BrokerRefusal("The bootstrap key is longer than 1 KiB");
      }
    }
    const key = buffer.toString("utf8", 0, length).trim();
    if (key === "") {
      throw new BrokerRefusal(
        "The bootstrap key is missing from standard input",
      );
    }
    return Secret.make(key, { label: "bootstrap key" });
  } finally {
    buffer.fill(0);
    closeSync(0);
  }
}

async function run(args: readonly string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--new-key") {
    process.stdout.write(`${await generateIdentity()}\n`);
    return;
  }
  if (args.length === 1 && args[0] === "--check-key") {
    const key = readBootstrapKey();
    try {
      await validateBootstrapKey(key);
    } finally {
      key.wipe();
    }
    process.stdout.write("The bootstrap key is a valid age identity\n");
    return;
  }
  if (args.length > 0) {
    throw new BrokerRefusal(
      "The secrets broker takes no arguments except --new-key and --check-key",
    );
  }
  if (process.platform !== "linux" || process.getuid?.() !== brokerUid) {
    throw new Error("The secrets broker requires its Linux service account");
  }
  const key = readBootstrapKey();
  process.umask(0o077);
  const groups = await readFile("/etc/group", "utf8");
  const harnessGid = /^harness:[^:\n]*:([0-9]+):/m.exec(groups)?.[1];
  const directory = await lstat(socketDirectory);
  if (
    !directory.isDirectory() ||
    directory.uid !== brokerUid ||
    directory.gid !== Number(harnessGid) ||
    (directory.mode & 0o7777) !== 0o2710
  ) {
    throw new Error("Unsafe broker socket directory");
  }

  const store = await openLocalStore(storeDirectory, key);
  const path = join(socketDirectory, "broker.sock");
  const server = createServer(
    { requestTimeout: 5_000, headersTimeout: 5_000 },
    (request, response) => {
      void handleRequest(request, response, store).catch(() => {
        logger.error("Secrets broker request failed");
        if (response.headersSent) response.destroy();
        else response.writeHead(500).end();
      });
    },
  );
  server.setTimeout(5_000, (socket) => socket.destroy());
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 1;
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connect", (_request, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  try {
    const socket = await lstat(path);
    if (
      !socket.isSocket() ||
      socket.uid !== brokerUid ||
      socket.gid !== directory.gid ||
      (socket.mode & 0o077) !== 0
    ) {
      throw new Error("Unsafe broker socket");
    }
    await chmod(path, 0o660);
  } catch (error) {
    server.close();
    throw error;
  }

  server.on("error", () => {
    logger.error("Secrets broker listener failed");
    process.exitCode = 1;
    server.close();
  });
  const stop = () => server.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  logger.error(
    "Secrets broker startup failed",
    error instanceof LocalStoreRefusal || error instanceof BrokerRefusal
      ? { reason: error.reason }
      : {},
  );
  process.exitCode = 1;
}
