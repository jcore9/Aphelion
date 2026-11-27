import { mkdirSync } from "node:fs";
import { botIdPattern, isBotFolder } from "../cgroups/protocol";
import { libc, PR_SET_DUMPABLE } from "./process-tree";

const refuse = (why: string): never => {
  process.stderr.write(`${why}, so it didn't start\n`);
  process.exit(1);
};

if (libc().prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n) !== 0) {
  refuse("the adapter couldn't hide its memory and pipes");
}

const bot = process.argv[2] ?? "";
const folder = process.argv[3] ?? "";
if (!botIdPattern.test(bot) || !isBotFolder(folder)) {
  refuse("the adapter was started without a bot id or folder");
}
try {
  mkdirSync(folder, { recursive: true, mode: 0o750 });
  process.chdir(folder);
} catch {
  refuse("the adapter couldn't enter its bot's folder");
}
