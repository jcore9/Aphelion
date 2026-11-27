import { spawn } from "node:child_process";
import {
  apiKeyVariable,
  claudeEnv,
  claudeExecutable,
  type ParentEnv,
} from "./options.ts";

export const signInCheckMs = 5_000;

export type SignInCheck = (parent: ParentEnv) => Promise<boolean>;

export function claudeSignedIn(
  parent: ParentEnv,
  executable: string = claudeExecutable,
  limitMs: number = signInCheckMs,
): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, ["auth", "status"], {
        env: claudeEnv(parent),
        stdio: "ignore",
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, limitMs);
    const settle = (signedIn: boolean) => {
      clearTimeout(timer);
      resolve(signedIn);
    };
    child.once("error", () => {
      settle(false);
    });
    child.once("exit", (code) => {
      settle(code === 0);
    });
  });
}

export async function sessionEnv(
  parent: ParentEnv,
  signedIn: SignInCheck = claudeSignedIn,
): Promise<Record<string, string>> {
  if (parent[apiKeyVariable] === undefined) return claudeEnv(parent);
  return claudeEnv(parent, (await signedIn(parent)) ? "working" : "none");
}
