import { dlopen, FFIType, read } from "bun:ffi";
import { closeSync, openSync } from "node:fs";

const LOCK_EX = 2;
const LOCK_NB = 4;
const EWOULDBLOCK = 11;

const open = () =>
  dlopen("libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  }).symbols;

let libc: ReturnType<typeof open> | undefined;

export type FileLock =
  | { readonly kind: "locked"; readonly release: () => void }
  | { readonly kind: "held" };

export function lockFile(path: string): FileLock {
  libc ??= open();
  const fd = openSync(path, "a", 0o600);
  if (libc.flock(fd, LOCK_EX | LOCK_NB) === 0) {
    return {
      kind: "locked",
      release: () => {
        closeSync(fd);
      },
    };
  }
  const where = libc.__errno_location();
  const errno = where === null ? -1 : read.i32(where, 0);
  closeSync(fd);
  if (errno === EWOULDBLOCK) return { kind: "held" };
  throw new Error(`flock failed with errno ${String(errno)}`);
}
