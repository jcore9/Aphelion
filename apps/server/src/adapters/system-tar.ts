import { execFile } from "node:child_process";

const run = (args: readonly string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      "tar",
      [...args],
      {
        encoding: "utf8",
        env: { LC_ALL: "C", TZ: "UTC", PATH: process.env["PATH"] ?? "" },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else reject(new Error(stderr.trim() || error.message));
      },
    );
  });

export const listArchive = (file: string) =>
  run(["--list", "--verbose", "--gzip", "--file", file]);

export const extractArchive = (file: string, folder: string) =>
  run([
    "--extract",
    "--gzip",
    "--file",
    file,
    "--directory",
    folder,
    "--no-same-owner",
    "--no-same-permissions",
  ]);
