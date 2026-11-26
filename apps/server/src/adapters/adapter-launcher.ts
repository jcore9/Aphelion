import { libc, PR_SET_DUMPABLE } from "./process-tree";

if (libc().prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n) !== 0) {
  process.stderr.write(
    "the adapter couldn't hide its memory and pipes, so it didn't start\n",
  );
  process.exit(1);
}
