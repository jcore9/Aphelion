import type { Parsed } from "./vendor-checksums";

const line =
  /^([-d])[-rwxsStT]{9}\s+\S+\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/;
const plainName = /^[A-Za-z0-9._+@-]+(\/[A-Za-z0-9._+@-]+)*\/?$/;

export function parseArchiveListing(text: string): Parsed<readonly string[]> {
  const files: string[] = [];
  for (const row of text.split("\n")) {
    if (row.trim() === "") continue;
    const found = line.exec(row);
    if (found === null) {
      return {
        ok: false,
        message:
          "the archive holds a link, a special file or a line Aphelion can't read",
      };
    }
    const [, kind = "", raw = ""] = found;
    const name = raw.replace(/^\.\//, "");
    if (name === "." || name === "") continue;
    if (
      !plainName.test(name) ||
      name.split("/").some((part) => part === "." || part === "..")
    ) {
      return {
        ok: false,
        message: `the archive holds a path outside its folder: ${raw}`,
      };
    }
    if (kind === "-") files.push(name);
  }
  return { ok: true, value: files };
}
