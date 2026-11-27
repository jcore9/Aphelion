import { request } from "node:http";
import { Secret } from "./secret";

export const brokerSocket = "/run/aphelion-secrets/broker.sock";
const maxAnswerBytes = 64 * 1024;
const timeoutMs = 5_000;

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

function send(socketPath: string, body: Buffer): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
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
          bytes += chunk.length;
          if (bytes > maxAnswerBytes) {
            response.destroy();
            reject(new BrokerError("the secrets broker's answer is too long"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", () => {
          reject(new BrokerError("the secrets broker's answer broke off"));
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks),
          });
          for (const chunk of chunks) chunk.fill(0);
        });
      },
    );
    call.on("error", (error) => {
      reject(unreachable(socketPath, error));
    });
    call.setTimeout(timeoutMs, () => {
      call.destroy(new BrokerError("the secrets broker didn't answer"));
    });
    call.end(body);
  });
}

const answered = (status: number) =>
  new BrokerError(`the secrets broker answered HTTP ${String(status)}`);

async function ask(socketPath: string, fields: object): Promise<Answer> {
  const body = Buffer.from(JSON.stringify(fields));
  try {
    return await send(socketPath, body);
  } finally {
    body.fill(0);
  }
}

export function brokerClient(socketPath: string = brokerSocket) {
  return {
    async read(ref: string): Promise<Secret | undefined> {
      const { status, body } = await ask(socketPath, { op: "read", ref });
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
      const { status } = await ask(socketPath, {
        op: "write",
        ref,
        value: value.reveal(),
      });
      if (status !== 204) throw answered(status);
    },
    async delete(ref: string): Promise<boolean> {
      const { status } = await ask(socketPath, { op: "delete", ref });
      if (status === 404) return false;
      if (status !== 204) throw answered(status);
      return true;
    },
  };
}

export type BrokerClient = ReturnType<typeof brokerClient>;
