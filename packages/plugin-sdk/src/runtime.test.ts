import { describe, expect, test } from "vitest";
import { HostError, type PluginIO, type ServerPlugin } from "./plugin.ts";
import { runPlugin, serve } from "./runtime.ts";

type Message = Record<string, unknown>;

function channel<T>() {
  const queued: T[] = [];
  const waiting: ((item: IteratorResult<T, undefined>) => void)[] = [];
  let ended = false;
  return {
    push(item: T) {
      const resolve = waiting.shift();
      if (resolve) resolve({ done: false, value: item });
      else queued.push(item);
    },
    end() {
      ended = true;
      for (const resolve of waiting.splice(0)) {
        resolve({ done: true, value: undefined });
      }
    },
    next(): Promise<IteratorResult<T, undefined>> {
      const item = queued.shift();
      if (item !== undefined)
        return Promise.resolve({ done: false, value: item });
      if (ended) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
}

function scriptedHost() {
  const toPlugin = channel<string>();
  const fromPlugin = channel<Message>();
  const logs: string[] = [];
  const io: PluginIO = {
    input: { [Symbol.asyncIterator]: () => ({ next: () => toPlugin.next() }) },
    write: (line) => {
      fromPlugin.push(JSON.parse(line) as Message);
      return Promise.resolve();
    },
    log: (message) => {
      logs.push(message);
    },
  };
  const send = (message: Message) => {
    toPlugin.push(JSON.stringify({ jsonrpc: "2.0", ...message }));
  };
  const read = async () => {
    const next = await fromPlugin.next();
    if (next.done) throw new Error("the plugin wrote nothing more");
    return next.value;
  };
  const initialize = async () => {
    send({
      id: 1,
      method: "initialize",
      params: { api: "0.2.1", plugin: "demo" },
    });
    expect(await read()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  };
  return {
    io,
    logs,
    send,
    read,
    initialize,
    reply: (request: Message, result: unknown) => {
      send({ id: request["id"], result });
    },
    refuse: (request: Message, code: number) => {
      send({ id: request["id"], error: { code, message: "Not granted" } });
    },
    event: (name: string, data: unknown) => {
      send({ method: "event", params: { name, data } });
    },
    shutdown: () => {
      send({ method: "shutdown" });
    },
    eof: () => {
      toPlugin.end();
    },
  };
}

const later = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("runPlugin", () => {
  test("answers initialize before it starts the plugin, then sends its requests", async () => {
    const host = scriptedHost();
    const seen: string[] = [];
    const run = runPlugin(
      {
        async start(ctx) {
          seen.push(`${ctx.id} ${ctx.api}`);
          await ctx.events.subscribe("demo.ping", () => undefined);
          seen.push("subscribed");
        },
      },
      host.io,
    );
    expect(seen).toEqual([]);
    await host.initialize();
    const subscribe = await host.read();
    expect(subscribe).toMatchObject({
      method: "events.subscribe",
      params: { event: "demo.ping" },
    });
    expect(seen).toEqual(["demo 0.2.1"]);
    host.reply(subscribe, {});
    await later();
    expect(seen).toEqual(["demo 0.2.1", "subscribed"]);
    host.shutdown();
    await run;
  });

  test("delivers events only to a subscription the host accepted", async () => {
    const host = scriptedHost();
    const got: unknown[] = [];
    const refusals: unknown[] = [];
    const run = runPlugin(
      {
        async start(ctx) {
          await ctx.events.subscribe("demo.ok", (data) => {
            got.push(data);
          });
          await ctx.events
            .subscribe("demo.secret", (data) => {
              got.push(data);
            })
            .catch((error: unknown) => {
              refusals.push(error);
            });
        },
      },
      host.io,
    );
    await host.initialize();
    host.reply(await host.read(), {});
    host.refuse(await host.read(), -32001);
    await later();
    host.event("demo.secret", "hidden");
    host.event("demo.ok", "shown");
    await later();
    expect(got).toEqual(["shown"]);
    expect(refusals).toEqual([
      new HostError({ code: -32001, message: "Not granted" }),
    ]);
    expect((refusals[0] as HostError).code).toBe(-32001);
    host.shutdown();
    await run;
  });

  test("logs a failing event handler and keeps handling events", async () => {
    const host = scriptedHost();
    const got: unknown[] = [];
    const run = runPlugin(
      {
        async start(ctx) {
          await ctx.events.subscribe("demo.ping", (data) => {
            if (data === "bad") throw new Error("handler broke");
            got.push(data);
          });
        },
      },
      host.io,
    );
    await host.initialize();
    host.reply(await host.read(), {});
    host.event("demo.ping", "bad");
    host.event("demo.ping", "good");
    await later();
    expect(got).toEqual(["good"]);
    expect(host.logs).toEqual([
      "the handler for demo.ping failed: handler broke",
    ]);
    host.shutdown();
    await run;
  });

  test("sends one network or secret request at a time", async () => {
    const host = scriptedHost();
    const replies: unknown[] = [];
    let ctxReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => (ctxReady = resolve));
    const run = runPlugin(
      {
        start(ctx) {
          void ctx.network
            .get("https://api.example.com/a")
            .then((reply) => replies.push(reply));
          void ctx.secrets
            .use("send", "op://vault/item/field")
            .then(() => replies.push("used"));
          ctxReady?.();
        },
      },
      host.io,
    );
    await host.initialize();
    await ready;
    const first = await host.read();
    expect(first).toMatchObject({ method: "network.get" });
    const second = host.read();
    expect(await Promise.race([second, later().then(() => "nothing")])).toBe(
      "nothing",
    );
    host.reply(first, { status: 200, body: "hello", extra: true });
    const secret = await second;
    expect(secret).toMatchObject({
      method: "secrets.use",
      params: { operation: "send", reference: "op://vault/item/field" },
    });
    host.reply(secret, {});
    await later();
    expect(replies).toEqual([{ status: 200, body: "hello" }, "used"]);
    host.shutdown();
    await run;
  });

  test("on shutdown it rejects waiting calls and runs the cleanup once", async () => {
    const host = scriptedHost();
    let cleanups = 0;
    let waiting: Promise<unknown> | undefined;
    const plugin: ServerPlugin = {
      start(ctx) {
        waiting = ctx.network
          .get("https://api.example.com/")
          .catch((error: unknown) => error);
        return () => {
          cleanups++;
        };
      },
    };
    const run = runPlugin(plugin, host.io);
    await host.initialize();
    await host.read();
    host.shutdown();
    host.shutdown();
    await run;
    expect(cleanups).toBe(1);
    expect(await waiting).toEqual(new Error("the plugin is shutting down"));
  });

  test("rejects a call whose params can't be sent, and shuts down cleanly after it", async () => {
    const host = scriptedHost();
    let failure: unknown;
    let cleanups = 0;
    const plugin: ServerPlugin = {
      async start(ctx) {
        failure = await ctx.network
          .get(1n as unknown as string)
          .catch((error: unknown) => error);
        return () => {
          cleanups++;
        };
      },
    };
    const run = runPlugin(plugin, host.io);
    await host.initialize();
    while (failure === undefined) await later();
    expect(failure).toBeInstanceOf(TypeError);
    host.shutdown();
    await run;
    expect(cleanups).toBe(1);
  });

  test("ends cleanly when the host closes its input", async () => {
    const host = scriptedHost();
    let cleanups = 0;
    const run = runPlugin(
      {
        start: () => () => {
          cleanups++;
        },
      },
      host.io,
    );
    await host.initialize();
    host.eof();
    await run;
    expect(cleanups).toBe(1);
  });

  test("runs cleanup and rethrows when reading from the host fails", async () => {
    const lines = [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { api: "0.2.1", plugin: "demo" },
      }),
    ];
    let cleanups = 0;
    const run = runPlugin(
      {
        start: () => () => {
          cleanups++;
        },
      },
      {
        input: {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              await Promise.resolve();
              const line = lines.shift();
              if (line === undefined) throw new Error("stdin broke");
              return { done: false, value: line };
            },
          }),
        },
        write: () => Promise.resolve(),
        log: () => undefined,
      },
    );
    await expect(run).rejects.toThrow("stdin broke");
    expect(cleanups).toBe(1);
  });

  test("runs cleanup and rethrows when a write from an event handler fails", async () => {
    const host = scriptedHost();
    let cleanups = 0;
    const run = runPlugin(
      {
        async start(ctx) {
          await ctx.events.subscribe("demo.ping", async () => {
            await ctx.network.get("https://api.example.com/");
          });
          return () => {
            cleanups++;
          };
        },
      },
      {
        ...host.io,
        write: (line) =>
          line.includes("network.get")
            ? Promise.reject(new Error("stdout broke"))
            : host.io.write(line),
      },
    );
    await host.initialize();
    host.reply(await host.read(), {});
    host.event("demo.ping", {});
    await expect(run).rejects.toThrow("stdout broke");
    expect(cleanups).toBe(1);
  });

  test("writes nothing more after a write fails, and rejects only once", async () => {
    const host = scriptedHost();
    const writes: string[] = [];
    let cleanups = 0;
    const run = runPlugin(
      {
        async start(ctx) {
          await ctx.events.subscribe("demo.ping", async () => {
            await Promise.allSettled([
              ctx.events.subscribe("demo.a", () => undefined),
              ctx.events.subscribe("demo.b", () => undefined),
            ]);
          });
          return () => {
            cleanups++;
          };
        },
      },
      {
        ...host.io,
        write: (line) => {
          writes.push(line);
          return line.includes("demo.a")
            ? Promise.reject(new Error("stdout broke"))
            : host.io.write(line);
        },
      },
    );
    await host.initialize();
    host.reply(await host.read(), {});
    host.event("demo.ping", {});
    await expect(run).rejects.toThrow("stdout broke");
    expect(cleanups).toBe(1);
    expect(writes.some((line) => line.includes("demo.b"))).toBe(false);
  });

  test("shuts down cleanly when a write fails after the shutdown", async () => {
    const host = scriptedHost();
    const stuck = Promise.withResolvers<undefined>();
    const run = runPlugin(
      {
        async start(ctx) {
          await ctx.events.subscribe("demo.ping", async () => {
            await ctx.network.get("https://api.example.com/");
          });
        },
      },
      {
        ...host.io,
        write: (line) =>
          line.includes("network.get") ? stuck.promise : host.io.write(line),
      },
    );
    await host.initialize();
    host.reply(await host.read(), {});
    host.event("demo.ping", {});
    host.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 20));
    stuck.reject(new Error("stdout broke"));
    await expect(run).resolves.toBeUndefined();
  });

  test("starts no queued write after the shutdown", async () => {
    const host = scriptedHost();
    const first = Promise.withResolvers<undefined>();
    const writes: string[] = [];
    const run = runPlugin(
      {
        async start(ctx) {
          await ctx.events.subscribe("demo.ping", async () => {
            await Promise.allSettled([
              ctx.events.subscribe("demo.a", () => undefined),
              ctx.events.subscribe("demo.b", () => undefined),
            ]);
          });
        },
      },
      {
        ...host.io,
        write: (line) => {
          writes.push(line);
          if (line.includes("demo.a")) return first.promise;
          if (line.includes("demo.b")) return new Promise(() => undefined);
          return host.io.write(line);
        },
      },
    );
    await host.initialize();
    host.reply(await host.read(), {});
    host.event("demo.ping", {});
    host.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 20));
    first.reject(new Error("stdout broke"));
    await expect(run).resolves.toBeUndefined();
    expect(writes.some((line) => line.includes("demo.b"))).toBe(false);
  });

  test("fails when start throws after the handshake", async () => {
    const host = scriptedHost();
    const run = runPlugin(
      {
        start() {
          throw new Error("no config");
        },
      },
      host.io,
    );
    await host.initialize();
    await expect(run).rejects.toThrow("no config");
    expect(host.logs).toEqual(["the plugin's start failed: no config"]);
  });

  test("answers an unknown host request with method not found", async () => {
    const host = scriptedHost();
    const run = runPlugin({ start: () => undefined }, host.io);
    await host.initialize();
    host.send({ id: 7, method: "status" });
    expect(await host.read()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "Method not found" },
    });
    host.shutdown();
    await run;
  });

  describe("at shutdown", () => {
    const subscribed = async (
      host: ReturnType<typeof scriptedHost>,
      count = 1,
    ) => {
      await host.initialize();
      for (let i = 0; i < count; i++) host.reply(await host.read(), {});
      await later();
    };

    test("ignores later events, lets a running handler finish, then runs cleanup", async () => {
      const host = scriptedHost();
      const order: string[] = [];
      const release = Promise.withResolvers<undefined>();
      const run = runPlugin(
        {
          async start(ctx) {
            await ctx.events.subscribe("demo.ping", async (data) => {
              order.push(`${String(data)} started`);
              await release.promise;
              order.push(`${String(data)} finished`);
            });
            return () => {
              order.push("cleanup");
            };
          },
        },
        host.io,
      );
      await subscribed(host);
      host.event("demo.ping", "first");
      await later();
      host.shutdown();
      host.event("demo.ping", "second");
      await later();
      expect(order).toEqual(["first started"]);
      release.resolve(undefined);
      await run;
      expect(order).toEqual(["first started", "first finished", "cleanup"]);
      expect(host.logs).toEqual([]);
    });

    test("also waits for handlers when the host closes its input", async () => {
      const host = scriptedHost();
      const order: string[] = [];
      const release = Promise.withResolvers<undefined>();
      const run = runPlugin(
        {
          async start(ctx) {
            await ctx.events.subscribe("demo.ping", async () => {
              await release.promise;
              order.push("handled");
            });
            return () => {
              order.push("cleanup");
            };
          },
        },
        host.io,
      );
      await subscribed(host);
      host.event("demo.ping", {});
      await later();
      host.eof();
      await later();
      release.resolve(undefined);
      await run;
      expect(order).toEqual(["handled", "cleanup"]);
    });

    test("runs cleanup when the grace is over, and logs which handlers still ran", async () => {
      const host = scriptedHost();
      const order: string[] = [];
      const run = serve(
        {
          async start(ctx) {
            await ctx.events.subscribe("demo.slow", async () => {
              await new Promise(() => undefined);
            });
            await ctx.events.subscribe("demo.quick", () => {
              order.push("quick");
            });
            return () => {
              order.push("cleanup");
            };
          },
        },
        host.io,
        { handlerGraceMs: 50 },
      );
      await subscribed(host, 2);
      host.event("demo.slow", { secret: "do not log" });
      host.event("demo.quick", {});
      await later();
      const begun = Date.now();
      host.shutdown();
      await run;
      expect(Date.now() - begun).toBeGreaterThanOrEqual(45);
      expect(order).toEqual(["quick", "cleanup"]);
      expect(host.logs).toEqual([
        "the handler for demo.slow was still running after 0.05 s, so the plugin's cleanup runs now",
      ]);
    });

    test("waits for no handler when none is running", async () => {
      const host = scriptedHost();
      const run = serve({ start: () => undefined }, host.io, {
        handlerGraceMs: 5000,
      });
      await host.initialize();
      const begun = Date.now();
      host.shutdown();
      await run;
      expect(Date.now() - begun).toBeLessThan(1000);
    });

    test("fails a host call that is still being written, and every call made after", async () => {
      const host = scriptedHost();
      const stuck = Promise.withResolvers<undefined>();
      const errors: unknown[] = [];
      const release = Promise.withResolvers<undefined>();
      let cleanups = 0;
      const run = runPlugin(
        {
          async start(ctx) {
            await ctx.events.subscribe("demo.fetch", async () => {
              errors.push(
                await ctx.network
                  .get("https://api.example.com/")
                  .catch((error: unknown) => error),
              );
              await release.promise;
              errors.push(
                await ctx.secrets
                  .use("send", "op://vault/item/field")
                  .catch((error: unknown) => error),
              );
            });
            return () => {
              cleanups++;
            };
          },
        },
        {
          ...host.io,
          write: (line) =>
            line.includes("network.get") ? stuck.promise : host.io.write(line),
        },
      );
      await subscribed(host);
      host.event("demo.fetch", {});
      await later();
      host.shutdown();
      await later();
      expect(errors).toEqual([new Error("the plugin is shutting down")]);
      expect(cleanups).toBe(0);
      release.resolve(undefined);
      await later();
      expect(errors).toEqual([
        new Error("the plugin is shutting down"),
        new Error("the plugin is shutting down"),
      ]);
      expect(cleanups).toBe(1);
      stuck.resolve(undefined);
      await run;
    });

    test("fails a host call that waits for its reply", async () => {
      const host = scriptedHost();
      const errors: unknown[] = [];
      const run = runPlugin(
        {
          async start(ctx) {
            await ctx.events.subscribe("demo.fetch", async () => {
              errors.push(
                await ctx.network
                  .get("https://api.example.com/")
                  .catch((error: unknown) => error),
              );
            });
          },
        },
        host.io,
      );
      await subscribed(host);
      host.event("demo.fetch", {});
      expect(await host.read()).toMatchObject({ method: "network.get" });
      host.shutdown();
      await run;
      expect(errors).toEqual([new Error("the plugin is shutting down")]);
    });
  });
});
