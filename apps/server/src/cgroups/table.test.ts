import { describe, expect, it } from "vitest";
import { probeAdapter } from "./supervisor";
import { adapterTable } from "./table";

describe("the supervisor's adapter table", () => {
  it("names ANTHROPIC_API_KEY for the Claude adapter and no key variable for the probe", () => {
    const table = adapterTable("/var/lib/aphelion-bots");
    expect(table["claude"]?.apiKeyVariable).toBe("ANTHROPIC_API_KEY");
    expect(table[probeAdapter]?.apiKeyVariable).toBeUndefined();
    expect(Object.keys(table).sort()).toEqual(["claude", probeAdapter].sort());
  });
});
