import { Secret } from "./secret";

export const apiKeyTools = ["claude", "codex", "grok"] as const;
export type ApiKeyTool = (typeof apiKeyTools)[number];

export const apiKeyRef = (tool: ApiKeyTool) => `local://apikey/${tool}`;

export const maxApiKeyBytes = 512;
const checkTimeoutMs = 10_000;

interface Provider {
  readonly vendor: string;
  readonly baseUrl: string;
  readonly headers: (key: string) => Record<string, string>;
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

export const providers: Readonly<Record<ApiKeyTool, Provider>> = {
  claude: {
    vendor: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  },
  codex: {
    vendor: "OpenAI",
    baseUrl: "https://api.openai.com",
    headers: bearer,
  },
  grok: { vendor: "xAI", baseUrl: "https://api.x.ai", headers: bearer },
};

export type ApiKeyInput =
  | { readonly ok: true; readonly key: Secret }
  | { readonly ok: false; readonly reason: string };

const refused = (reason: string): ApiKeyInput => ({ ok: false, reason });

export function apiKeyFromInput(input: Uint8Array): ApiKeyInput {
  try {
    let end = input.length;
    if (input[end - 1] === 0x0a) end -= 1;
    if (input[end - 1] === 0x0d) end -= 1;
    if (end === 0) return refused("The API key is empty.");
    if (end > maxApiKeyBytes) {
      return refused(
        `The API key is longer than ${String(maxApiKeyBytes)} bytes.`,
      );
    }
    const bytes = input.subarray(0, end);
    if (bytes.some((byte) => byte < 0x21 || byte > 0x7e)) {
      return refused("The API key has a line break or a control character.");
    }
    return {
      ok: true,
      key: Secret.make(new TextDecoder().decode(bytes), {
        label: "API key",
      }),
    };
  } finally {
    input.fill(0);
  }
}

export type CheckResult =
  | { readonly kind: "accepted" | "refused" | "unreachable" }
  | { readonly kind: "status"; readonly status: number };

export async function checkApiKey(
  tool: ApiKeyTool,
  key: Secret,
  {
    baseUrl = providers[tool].baseUrl,
    timeoutMs = checkTimeoutMs,
  }: { readonly baseUrl?: string; readonly timeoutMs?: number } = {},
): Promise<CheckResult> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/models`, {
      method: "GET",
      headers: providers[tool].headers(key.reveal()),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: "unreachable" };
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 200) return { kind: "accepted" };
  if (response.status === 401 || response.status === 403) {
    return { kind: "refused" };
  }
  return { kind: "status", status: response.status };
}
