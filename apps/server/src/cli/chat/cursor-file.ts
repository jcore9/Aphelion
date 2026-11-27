import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { cursor, type Cursor } from "@aphelion/protocol";

export const fileCursorStore = (path: string) => ({
  load: (): Cursor | null => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = cursor.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
  save: (position: Cursor) => {
    const next = `${path}.next`;
    writeFileSync(next, JSON.stringify(position), { mode: 0o600 });
    renameSync(next, path);
  },
});
