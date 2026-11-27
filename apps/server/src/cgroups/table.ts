import { botEnvironment } from "../bots/environment";
import { probeAdapter, type AdapterEntry } from "./supervisor";

export const adapterTable = (
  home: string,
): Readonly<Record<string, AdapterEntry>> => ({
  claude: {
    bundle: "/usr/local/lib/aphelion/adapters/claude/adapter.js",
    env: botEnvironment("claude", home),
    apiKeyVariable: "ANTHROPIC_API_KEY",
  },
  [probeAdapter]: {
    bundle: "/usr/local/lib/aphelion/cgroup-probe.js",
    env: botEnvironment(probeAdapter, "/tmp"),
  },
});
