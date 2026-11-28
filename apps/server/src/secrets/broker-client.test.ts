import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity } from "age-encryption";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleBrokerRequest } from "./broker-handler";
import { BrokerError, brokerClient } from "./broker-client";
import { openLocalStore } from "./local-store";
import { Secret } from "./secret";

const canary = "sk-ant-fake-broker-client-canary-0123456789";
const ref = "local://apikey/claude";

let root: string;
let socket: string;
let server: Server;

const listen = (handler: Parameters<typeof createServer>[1]) =>
  new Promise<Server>((resolve) => {
    const made = createServer(handler);
    made.listen(socket, () => {
      resolve(made);
    });
  });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aphelion-broker-client-"));
  socket = join(root, "broker.sock");
  const storeDirectory = join(root, "store");
  await mkdir(storeDirectory, { mode: 0o700 });
  const store = await openLocalStore(
    storeDirectory,
    Secret.make(await generateIdentity()),
  );
  server = await listen((request, response) => {
    void handleBrokerRequest(request, response, store);
  });
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

const messageOf = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(BrokerError);
  return String(error);
};

describe("the broker client", () => {
  it("writes, reads as a Secret, and deletes an entry", async () => {
    const broker = brokerClient(socket);
    expect(await broker.read(ref)).toBeUndefined();
    const value = Secret.make(canary);
    try {
      await broker.write(ref, value);
    } finally {
      value.wipe();
    }
    const read = await broker.read(ref);
    try {
      expect(read).toBeInstanceOf(Secret);
      expect(String(read)).not.toContain(canary);
      expect(read?.reveal()).toBe(canary);
    } finally {
      read?.wipe();
    }
    expect(await broker.delete(ref)).toBe(true);
    expect(await broker.read(ref)).toBeUndefined();
    expect(await broker.delete(ref)).toBe(false);
  });

  it("refuses a reference the broker doesn't take, without the value", async () => {
    const broker = brokerClient(socket);
    const value = Secret.make(canary);
    try {
      const message = await messageOf(broker.write("op://vault/item", value));
      expect(message).toContain("the secrets broker answered HTTP 400");
      expect(message).not.toContain(canary);
    } finally {
      value.wipe();
    }
    expect(await messageOf(broker.delete("local://Bad Ref"))).toContain(
      "HTTP 400",
    );
  });

  it("says plainly when the broker can't be reached", async () => {
    const broker = brokerClient(join(root, "missing.sock"));
    const value = Secret.make(canary);
    try {
      const message = await messageOf(broker.write(ref, value));
      expect(message).toContain("can't reach the secrets broker");
      expect(message).not.toContain(canary);
    } finally {
      value.wipe();
    }
    expect(await messageOf(broker.read(ref))).toContain(
      "can't reach the secrets broker",
    );
  });

  it("refuses an answer that isn't a JSON string, without repeating it", async () => {
    await answerWith((_request, response) => {
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(`{"value":"${canary}"}`);
    });
    const message = await messageOf(brokerClient(socket).read(ref));
    expect(message).toContain("the secrets broker gave an answer");
    expect(message).not.toContain(canary);
  });

  it.skipIf(process.getuid?.() === 0)(
    "says to run it as harness when the socket refuses this user",
    async () => {
      await chmod(socket, 0o000);
      expect(await messageOf(brokerClient(socket).read(ref))).toBe(
        `BrokerError: this user can't reach the secrets broker at ${socket}. Run it as harness.`,
      );
    },
  );

  it("refuses an answer longer than 64 KiB, without repeating it", async () => {
    await answerWith((_request, response) => {
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(canary.repeat(2000)));
    });
    const message = await messageOf(brokerClient(socket).read(ref));
    expect(message).toBe(
      "BrokerError: the secrets broker's answer is too long",
    );
  });

  it("says the answer broke off when the broker stops mid-answer", async () => {
    await answerWith((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": "1000",
      });
      response.write(`"${canary}`, () => {
        response.socket?.destroy();
      });
    });
    const message = await messageOf(brokerClient(socket).read(ref));
    expect(message).toBe("BrokerError: the secrets broker's answer broke off");
  });

  it("says the broker didn't answer when it stays silent", async () => {
    await answerWith((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write(`"${canary}`);
    });
    const message = await messageOf(
      brokerClient(socket, { timeoutMs: 200 }).read(ref),
    );
    expect(message).toBe("BrokerError: the secrets broker didn't answer");
  });
});

async function answerWith(handler: Parameters<typeof createServer>[1]) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  server = await listen(handler);
}

describe("waiting for the broker", () => {
  it("answers true once the broker's socket takes a connection, even when it starts late", async () => {
    const late = join(root, "late.sock");
    const started: Server[] = [];
    const timer = setTimeout(() => {
      started.push(createServer().listen(late));
    }, 200);
    try {
      expect(await brokerClient(late).answers(3_000)).toBe(true);
    } finally {
      clearTimeout(timer);
      for (const made of started) {
        await new Promise((resolve) => made.close(resolve));
      }
    }
  });

  it("answers false when nothing takes a connection before the limit", async () => {
    const began = Date.now();
    expect(await brokerClient(join(root, "missing.sock")).answers(300)).toBe(
      false,
    );
    const waited = Date.now() - began;
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(2_000);
  });

  it("answers false soon after its caller gives up", async () => {
    const giveUp = new AbortController();
    setTimeout(() => {
      giveUp.abort();
    }, 150);
    const began = Date.now();
    expect(
      await brokerClient(join(root, "missing.sock")).answers(
        10_000,
        giveUp.signal,
      ),
    ).toBe(false);
    expect(Date.now() - began).toBeLessThan(1_000);
  });

  it("answers false without trying the socket when its caller already gave up", async () => {
    const live = join(root, "live.sock");
    const server = createNetServer().listen(live);
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const gaveUp = new AbortController();
      gaveUp.abort();
      expect(await brokerClient(live).answers(3_000, gaveUp.signal)).toBe(
        false,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
