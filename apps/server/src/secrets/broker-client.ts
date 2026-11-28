import { request } from "node:http";
import { connect } from "node:net";
import { Secret } from "./secret";

export const brokerSocket = "/run/aphelion-secrets/broker.sock";
const maxAnswerBytes = 64 * 1024;
const defaultTimeoutMs = 5_000;
const answerRetryMs = 100;

export class BrokerError extends Error {
  override name = "BrokerError";
}

interface Answer {
  readonly status: number;
  readonly body: Buffer;
}

const unreachable = (socketPath: string, error: unknown) => {
  const code =
    error instanceof Error && "code" in error ? String(error.code) : "";
  return new BrokerError(
    code === "EACCES"
      ? `this user can't reach the secrets broker at ${socketPath}. Run it as harness.`
      : `can't reach the secrets broker at ${socketPath}`,
  );
};

function send(
  socketPath: string,
  body: Buffer,
  timeoutMs: number,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const wipe = () => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    const fail = (error: BrokerError) => {
      if (settled) return;
      settled = true;
      wipe();
      call.destroy();
      reject(error);
    };
    const call = request(
      {
        socketPath,
        path: "/v1/local",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length,
        },
      },
      (response) => {
        response.on("data", (chunk: Buffer) => {
          if (settled) {
            chunk.fill(0);
            return;
          }
          chunks.push(chunk);
          bytes += chunk.length;
          if (bytes > maxAnswerBytes) {
            fail(new BrokerError("the secrets broker's answer is too long"));
          }
        });
        response.on("error", () => {
          fail(new BrokerError("the secrets broker's answer broke off"));
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          const answer = Buffer.concat(chunks);
          wipe();
          resolve({ status: response.statusCode ?? 0, body: answer });
        });
        response.on("close", () => {
          fail(new BrokerError("the secrets broker's answer broke off"));
        });
      },
    );
    call.on("error", (error) => {
      fail(unreachable(socketPath, error));
    });
    call.setTimeout(timeoutMs, () => {
      fail(new BrokerError("the secrets broker didn't answer"));
    });
    call.end(body);
  });
}

const takesConnection = (
  socketPath: string,
  limitMs: number,
  signal?: AbortSignal,
) =>
  new Promise<boolean>((resolve) => {
    const probe = connect(socketPath);
    const refuse = () => {
      signal?.removeEventListener("abort", refuse);
      probe.destroy();
      resolve(false);
    };
    signal?.addEventListener("abort", refuse, { once: true });
    probe.setTimeout(Math.max(limitMs, 1), refuse);
    probe.once("error", refuse);
    probe.once("connect", () => {
      signal?.removeEventListener("abort", refuse);
      probe.setTimeout(0);
      probe.end();
      resolve(true);
    });
  });

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

async function answersWithin(
  socketPath: string,
  limitMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const until = Date.now() + limitMs;
  const gaveUp = () => signal?.aborted === true;
  for (;;) {
    if (gaveUp()) return false;
    if (await takesConnection(socketPath, until - Date.now(), signal)) {
      return true;
    }
    const left = until - Date.now();
    if (left <= 0 || gaveUp()) return false;
    await pause(Math.min(answerRetryMs, left), signal);
  }
}

const answered = (status: number) =>
  new BrokerError(`the secrets broker answered HTTP ${String(status)}`);

async function ask(
  socketPath: string,
  timeoutMs: number,
  fields: object,
): Promise<Answer> {
  const body = Buffer.from(JSON.stringify(fields));
  try {
    return await send(socketPath, body, timeoutMs);
  } finally {
    body.fill(0);
  }
}

export function brokerClient(
  socketPath: string = brokerSocket,
  { timeoutMs = defaultTimeoutMs }: { readonly timeoutMs?: number } = {},
) {
  return {
    answers: (limitMs: number, signal?: AbortSignal) =>
      answersWithin(socketPath, limitMs, signal),
    async read(ref: string): Promise<Secret | undefined> {
      const { status, body } = await ask(socketPath, timeoutMs, {
        op: "read",
        ref,
      });
      try {
        if (status === 404) return undefined;
        if (status !== 200) throw answered(status);
        let value: unknown;
        try {
          value = JSON.parse(body.toString("utf8"));
        } catch {
          value = undefined;
        }
        if (typeof value !== "string") {
          throw new BrokerError(
            "the secrets broker gave an answer that isn't a stored value",
          );
        }
        return Secret.make(value);
      } finally {
        body.fill(0);
      }
    },
    async write(ref: string, value: Secret): Promise<void> {
      const { status } = await ask(socketPath, timeoutMs, {
        op: "write",
        ref,
        value: value.reveal(),
      });
      if (status !== 204) throw answered(status);
    },
    async delete(ref: string): Promise<boolean> {
      const { status } = await ask(socketPath, timeoutMs, {
        op: "delete",
        ref,
      });
      if (status === 404) return false;
      if (status !== 204) throw answered(status);
      return true;
    },
  };
}

export type BrokerClient = ReturnType<typeof brokerClient>;
