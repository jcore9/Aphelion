import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { request } from "node:http";
import { createConnection } from "node:net";
import process from "node:process";

const socketPath = "/run/aphelion-secrets/broker.sock";
const ref = "local://contract/check";
const value = "broker-canary-🔑-4a4874ca";

async function send(text) {
  return await new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: "/v1/local",
        method: "POST",
        headers: { "Content-Length": Buffer.byteLength(text) },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve([res.statusCode, Buffer.concat(chunks).toString()]),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(5_000, () =>
      req.destroy(new Error("Broker request timed out")),
    );
    req.end(text);
  });
}

switch (process.argv[2]) {
  case "write": {
    assert.deepEqual(await send(JSON.stringify({ op: "read", ref })), [
      404,
      "",
    ]);
    assert.deepEqual(
      await send(
        JSON.stringify({ op: "write", ref: "op://vault/item/field", value }),
      ),
      [400, ""],
    );
    assert.deepEqual(await send('{"value":"broker-canary-malformed"'), [
      400,
      "",
    ]);
    assert.deepEqual(await send(JSON.stringify({ op: "write", ref, value })), [
      204,
      "",
    ]);
    const sizeTestRef = "local://contract/size";
    const writeSized = (size) =>
      JSON.stringify({
        op: "write",
        ref: sizeTestRef,
        value: "a".repeat(size),
      });
    const limit = 64 * 1024 - Buffer.byteLength(writeSized(0));
    assert.deepEqual(await send(writeSized(limit)), [204, ""]);
    await assert.rejects(send(writeSized(limit + 1)), { code: "ECONNRESET" });
    assert.deepEqual(
      await send(JSON.stringify({ op: "read", ref: sizeTestRef })),
      [200, JSON.stringify("a".repeat(limit))],
    );
    break;
  }
  case "read":
    assert.deepEqual(await send(JSON.stringify({ op: "read", ref })), [
      200,
      JSON.stringify(value),
    ]);
    break;
  case "denied": {
    const connected = new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.once("connect", () => {
        socket.destroy();
        resolve(undefined);
      });
      socket.once("error", reject);
    });
    await assert.rejects(connected, { code: "EACCES" });
    break;
  }
  default:
    throw new Error("Unknown broker probe");
}
