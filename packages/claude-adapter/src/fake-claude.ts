import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FakeClaudeAnswer =
  "signed-in" | "signed-out" | "hangs" | "reads-project-settings";

export interface FakeClaude {
  readonly path: string;
  readonly calls: () => readonly string[];
  readonly remove: () => void;
}

const behavior: Readonly<Record<FakeClaudeAnswer, string>> = {
  "signed-in": 'echo \'{"loggedIn": true, "authMethod": "claude.ai"}\'\nexit 0',
  "signed-out": 'echo \'{"loggedIn": false, "authMethod": "none"}\'\nexit 1',
  hangs: "exec sleep 30",
  "reads-project-settings": "test -f .claude/settings.json",
};

export function fakeClaude(answer: FakeClaudeAnswer): FakeClaude {
  const folder = mkdtempSync(join(tmpdir(), "aphelion-fake-claude-"));
  const path = join(folder, "claude");
  const record = join(folder, "calls");
  writeFileSync(record, "");
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s key=%s home=%s\\n' "$*" "\${ANTHROPIC_API_KEY:+set}" "$HOME" >>'${record}'\n${behavior[answer]}\n`,
  );
  chmodSync(path, 0o755);
  return {
    path,
    calls: () => readFileSync(record, "utf8").split("\n").filter(Boolean),
    remove: () => {
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
