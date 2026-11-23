import { describe, expect, test } from "vitest";
import type { PluginContext, ServerPlugin } from "./plugin.ts";
import { createTestHost, type Grant } from "./testing.ts";

const manifest = {
  id: "demo",
  version: "1.0.0",
  api: "^0.2.0",
  server: { entry: "server.mjs" },
  permissions: {
    events: ["demo.ping", "demo.other"],
    network: ["api.example.com", "hooks.example.com"],
    secrets: ["op://vault/item/token"],
  },
};

const canary = "canary-7f3a9c";
const token = "op://vault/item/token";

function hostWith(grants: readonly Grant[]) {
  const host = createTestHost(manifest);
  host.setGrants(grants);
  return host;
}

function capture(): { plugin: ServerPlugin; ctx: () => PluginContext } {
  let saved: PluginContext | undefined;
  return {
    plugin: {
      start(ctx) {
        saved = ctx;
      },
    },
    ctx: () => {
      if (!saved) throw new Error("the plugin hasn't started");
      return saved;
    },
  };
}

const outcome = (promise: Promise<unknown>) =>
  promise.then(
    (result) => ({ result }),
    (error: unknown) => ({
      code: (error as { code?: number }).code,
      message: (error as Error).message,
    }),
  );

describe("createTestHost", () => {
  test("delivers a published event to a granted subscription and waits for its handler", async () => {
    const host = hostWith([{ kind: "events", name: "demo.ping" }]);
    const seen: unknown[] = [];
    await host.start({
      async start(ctx) {
        await ctx.events.subscribe("demo.ping", async (data) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          seen.push(data);
          ctx.log(`pinged ${String(data)}`);
        });
      },
    });
    await host.publish("demo.ping", "one");
    expect(seen).toEqual(["one"]);
    expect(host.logs).toEqual(["pinged one"]);
    expect(host.calls).toEqual([
      {
        method: "events.subscribe",
        params: { event: "demo.ping" },
        outcome: { result: {} },
      },
    ]);
    await host.stop();
  });

  test("refuses a subscription that isn't granted, or isn't declared", async () => {
    const host = hostWith([
      { kind: "events", name: "demo.ping" },
      { kind: "events", name: "demo.undeclared" },
    ]);
    const { plugin, ctx } = capture();
    await host.start(plugin);
    const subscribe = (name: string) =>
      outcome(ctx().events.subscribe(name, () => undefined));
    expect(await subscribe("demo.ping")).toEqual({ result: undefined });
    expect(await subscribe("demo.other")).toEqual({
      code: -32001,
      message: "Not granted",
    });
    expect(await subscribe("demo.undeclared")).toEqual({
      code: -32001,
      message: "Not granted",
    });
    await host.stop();
  });

  test("checks the grant again when it delivers an event", async () => {
    const host = hostWith([{ kind: "events", name: "demo.ping" }]);
    const seen: unknown[] = [];
    await host.start({
      async start(ctx) {
        await ctx.events.subscribe("demo.ping", (data) => {
          seen.push(data);
        });
      },
    });
    await host.publish("demo.ping", "granted");
    host.setGrants([]);
    await host.publish("demo.ping", "revoked");
    await host.publish("demo.other", "never subscribed");
    expect(seen).toEqual(["granted"]);
    await host.stop();
  });

  test("answers network.get only for a granted host with a registered response", async () => {
    const host = hostWith([{ kind: "network", name: "api.example.com" }]);
    host.respondToGet("https://api.example.com/status", () => ({
      status: 200,
      body: "fine",
    }));
    const { plugin, ctx } = capture();
    await host.start(plugin);
    const get = (url: string) => outcome(ctx().network.get(url));
    expect(await get("https://api.example.com/status")).toEqual({
      result: { status: 200, body: "fine" },
    });
    expect(await get("https://hooks.example.com/status")).toEqual({
      code: -32001,
      message: "Not granted",
    });
    expect(await get("http://api.example.com/status")).toEqual({
      code: -32602,
      message: "Invalid params",
    });
    expect(await get("https://api.example.com/missing")).toEqual({
      code: -32003,
      message: "Operation failed",
    });
    await host.stop();
  });

  test("fails a network response larger than 64 KiB, as the real host does", async () => {
    const host = hostWith([{ kind: "network", name: "api.example.com" }]);
    host.respondToGet("https://api.example.com/big", () => ({
      status: 200,
      body: "x".repeat(64 * 1024 + 1),
    }));
    host.respondToGet("https://api.example.com/fits", () => ({
      status: 200,
      body: "x".repeat(64 * 1024),
    }));
    const { plugin, ctx } = capture();
    await host.start(plugin);
    expect(
      await outcome(ctx().network.get("https://api.example.com/big")),
    ).toEqual({ code: -32003, message: "Operation failed" });
    expect(
      (await ctx().network.get("https://api.example.com/fits")).body,
    ).toHaveLength(64 * 1024);
    await host.stop();
  });

  test("keeps delivering events after a publish that can't be serialized", async () => {
    const host = hostWith([{ kind: "events", name: "demo.ping" }]);
    const seen: unknown[] = [];
    await host.start({
      async start(ctx) {
        await ctx.events.subscribe("demo.ping", (data) => {
          seen.push(data);
        });
      },
    });
    await expect(host.publish("demo.ping", { n: 1n })).rejects.toThrow();
    await host.publish("demo.ping", { n: 2 });
    expect(seen).toEqual([{ n: 2 }]);
    await host.stop();
  });

  test("runs two network requests from the plugin one after the other", async () => {
    const host = hostWith([{ kind: "network", name: "api.example.com" }]);
    let active = 0;
    let most = 0;
    host.respondToGet("https://api.example.com/", async () => {
      active++;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { status: 204, body: "" };
    });
    const { plugin, ctx } = capture();
    await host.start(plugin);
    const both = await Promise.all([
      ctx().network.get("https://api.example.com/"),
      ctx().network.get("https://api.example.com/"),
    ]);
    expect(both).toEqual([
      { status: 204, body: "" },
      { status: 204, body: "" },
    ]);
    expect(most).toBe(1);
    await host.stop();
  });

  test("checks secrets.use in the real host's order", async () => {
    const secretGrant: Grant = { kind: "secrets", name: token };
    const destination: Grant = { kind: "network", name: "hooks.example.com" };
    const use = async (
      grants: readonly Grant[],
      operation: string,
      register: boolean,
    ) => {
      const host = hostWith(grants);
      if (register) {
        host.registerSecretOperation("notify", {
          reference: token,
          host: "hooks.example.com",
          run: () => undefined,
        });
        host.registerSecretOperation("elsewhere", {
          reference: "op://vault/item/other",
          host: "hooks.example.com",
          run: () => undefined,
        });
      }
      const { plugin, ctx } = capture();
      await host.start(plugin);
      const result = await outcome(ctx().secrets.use(operation, token));
      await host.stop();
      return result;
    };
    const notGranted = { code: -32001, message: "Not granted" };
    expect(await use([], "notify", false)).toEqual(notGranted);
    expect(await use([secretGrant], "notify", false)).toEqual({
      code: -32002,
      message: "The host doesn't offer secret operations yet",
    });
    expect(await use([secretGrant], "unknown", true)).toEqual(notGranted);
    expect(await use([secretGrant, destination], "elsewhere", true)).toEqual(
      notGranted,
    );
    expect(await use([secretGrant], "notify", true)).toEqual(notGranted);
    expect(await use([secretGrant, destination], "notify", true)).toEqual({
      result: undefined,
    });
  });

  test("never hands what a secret operation returns or throws to the plugin", async () => {
    const host = hostWith([
      { kind: "secrets", name: token },
      { kind: "network", name: "hooks.example.com" },
    ]);
    const ran: string[] = [];
    host.registerSecretOperation("returns", {
      reference: token,
      host: "hooks.example.com",
      run: (plugin) => {
        ran.push(plugin);
        return { value: canary };
      },
    });
    host.registerSecretOperation("throws", {
      reference: token,
      host: "hooks.example.com",
      run: () => {
        throw new Error(canary);
      },
    });
    const seen: unknown[] = [];
    await host.start({
      async start(ctx) {
        for (const operation of ["returns", "throws"]) {
          try {
            await ctx.secrets.use(operation, token);
            seen.push("used");
          } catch (error) {
            seen.push(error, (error as Error).message);
          }
        }
        ctx.log(JSON.stringify(seen));
      },
    });
    await host.stop();
    expect(ran).toEqual(["demo"]);
    expect(seen).toEqual(["used", expect.any(Error), "Operation failed"]);
    const visible = JSON.stringify({
      seen,
      logs: host.logs,
      calls: host.calls,
    });
    expect(visible).not.toContain(canary);
  });

  test("rejects start when the plugin's start throws, and runs cleanup on stop", async () => {
    const failing = hostWith([]);
    await expect(
      failing.start({
        start() {
          throw new Error("no config");
        },
      }),
    ).rejects.toThrow("no config");
    await failing.stop();

    const host = hostWith([]);
    let cleanups = 0;
    await host.start({
      start: () => () => {
        cleanups++;
      },
    });
    await host.stop();
    expect(cleanups).toBe(1);
  });

  test("stop lets a running handler finish, sends no later event, and runs cleanup last", async () => {
    const host = hostWith([{ kind: "events", name: "demo.ping" }]);
    const release = Promise.withResolvers<undefined>();
    const started = Promise.withResolvers<undefined>();
    await host.start({
      async start(ctx) {
        await ctx.events.subscribe("demo.ping", async (data) => {
          ctx.log(`${String(data)} started`);
          started.resolve(undefined);
          await release.promise;
          ctx.log(`${String(data)} finished`);
        });
        return () => {
          ctx.log("cleanup");
        };
      },
    });
    const first = host.publish("demo.ping", "first");
    await started.promise;
    const stopping = host.stop();
    await host.publish("demo.ping", "second");
    release.resolve(undefined);
    await first;
    await Promise.all([stopping, host.stop()]);
    expect(host.logs).toEqual(["first started", "first finished", "cleanup"]);
  });

  test("answers no request that arrives after stop is called", async () => {
    const host = hostWith([{ kind: "network", name: "api.example.com" }]);
    let asked = 0;
    host.respondToGet("https://api.example.com/", () => {
      asked++;
      return { status: 204, body: "" };
    });
    const { plugin, ctx } = capture();
    await host.start(plugin);
    const call = ctx()
      .network.get("https://api.example.com/")
      .catch((error: unknown) => error);
    await host.stop();
    expect(await call).toEqual(new Error("the plugin is shutting down"));
    expect(asked).toBe(0);
    expect(host.calls).toEqual([]);
  });

  test("refuses a manifest without a server part", () => {
    expect(() =>
      createTestHost({
        id: "demo",
        version: "1.0.0",
        api: "^0.2.0",
        client: { entry: "ui.js" },
      }),
    ).toThrow("the manifest has no server part");
    expect(() => createTestHost({ ...manifest, id: "Bad" })).toThrow(
      "the manifest is invalid",
    );
  });
});
