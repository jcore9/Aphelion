import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { extractArchive, listArchive } from "../adapters/system-tar";
import { parseArchiveListing } from "./archive";
import { buildFor, type Build, type Processor, type Tool } from "./list";

export class ToolRefused extends Data.TaggedError("ToolRefused")<{
  readonly reason: string;
}> {}

export type ToolState = "installed" | "not installed" | "unavailable";
export type InstallOutcome = "installed" | "unchanged";

export const stagingFolder = ".staging";
const downloadTimeoutMs = 30 * 60 * 1000;

const refuse = (reason: string) => new ToolRefused({ reason });
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const isRegularFile = (path: string) =>
  lstat(path).then(
    (info) => info.isFile(),
    () => false,
  );

async function currentVersion(toolFolder: string) {
  try {
    return await readlink(join(toolFolder, "current"));
  } catch {
    return undefined;
  }
}

async function stateOf(
  toolsDir: string,
  tool: Tool,
  build: Build,
): Promise<ToolState> {
  const folder = join(toolsDir, tool.name);
  const installed =
    (await currentVersion(folder)) === tool.version &&
    (await isRegularFile(join(folder, tool.version, build.entry)));
  return installed ? "installed" : "not installed";
}

export async function toolState(
  toolsDir: string,
  tool: Tool,
  processor: Processor,
): Promise<ToolState> {
  const found = buildFor(tool, processor);
  return found.kind === "unavailable"
    ? "unavailable"
    : stateOf(toolsDir, tool, found.build);
}

async function download(build: Build, file: string) {
  let response: Response;
  try {
    response = await fetch(build.url, {
      signal: AbortSignal.timeout(downloadTimeoutMs),
    });
  } catch (error) {
    throw refuse(`can't download ${build.url}: ${errorText(error)}`);
  }
  if (!response.ok || response.body === null) {
    throw refuse(`${build.url} answered ${String(response.status)}`);
  }
  const announced = Number(response.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > build.size) {
    throw refuse(
      `the download is ${String(announced)} bytes, more than the ${String(build.size)} the list allows`,
    );
  }
  const hash = createHash("sha256");
  let received = 0;
  const handle = await open(file, "wx", 0o600);
  try {
    await response.body.pipeTo(
      new WritableStream<Uint8Array>({
        async write(chunk) {
          received += chunk.byteLength;
          if (received > build.size) {
            throw refuse(
              `the download is larger than the ${String(build.size)} bytes the list allows`,
            );
          }
          hash.update(chunk);
          await handle.write(chunk);
        },
      }),
    );
  } catch (error) {
    throw error instanceof ToolRefused
      ? error
      : refuse(`the download broke off: ${errorText(error)}`);
  } finally {
    await handle.close();
  }
  if (received !== build.size) {
    throw refuse(
      `the download is ${String(received)} bytes, not the ${String(build.size)} the list says`,
    );
  }
  const digest = hash.digest("hex");
  if (digest !== build.sha256) {
    throw refuse(
      `the download's SHA-256 is ${digest}, not the ${build.sha256} the list says. Nothing was installed`,
    );
  }
}

async function makeReadOnlyToOthers(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw refuse("the archive holds a link");
  if (!info.isDirectory()) {
    await chmod(path, (info.mode & 0o111) === 0 ? 0o644 : 0o755);
    return;
  }
  await chmod(path, 0o755);
  for (const name of await readdir(path)) {
    await makeReadOnlyToOthers(join(path, name));
  }
}

async function unpack(build: Build, file: string, folder: string) {
  await mkdir(folder, { mode: 0o755 });
  const program = join(folder, build.entry);
  if (build.format === "binary") {
    await rename(file, program);
  } else {
    const listing = parseArchiveListing(await listArchive(file));
    if (!listing.ok) throw refuse(listing.message);
    if (!listing.value.includes(build.entry)) {
      throw refuse(`the archive has no ${build.entry}`);
    }
    await extractArchive(file, folder);
    if (!(await isRegularFile(program))) {
      throw refuse(`${build.entry} isn't a regular file`);
    }
  }
  await makeReadOnlyToOthers(folder);
  await chmod(program, 0o755);
}

async function install(toolsDir: string, tool: Tool, build: Build) {
  if ((await stateOf(toolsDir, tool, build)) === "installed") {
    return "unchanged" as const;
  }
  const staging = join(toolsDir, stagingFolder);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    const file = join(staging, "download");
    const folder = join(staging, tool.version);
    await download(build, file);
    await unpack(build, file, folder);

    const toolFolder = join(toolsDir, tool.name);
    await mkdir(toolFolder, { recursive: true, mode: 0o755 });
    for (const name of await readdir(toolFolder)) {
      if (name.startsWith("current.new-")) {
        await rm(join(toolFolder, name), { force: true });
      }
    }
    await rm(join(toolFolder, tool.version), { recursive: true, force: true });
    await rename(folder, join(toolFolder, tool.version));
    const link = join(
      toolFolder,
      `current.new-${randomBytes(6).toString("hex")}`,
    );
    await symlink(tool.version, link);
    await rename(link, join(toolFolder, "current"));
    for (const name of await readdir(toolFolder)) {
      if (name !== "current" && name !== tool.version) {
        await rm(join(toolFolder, name), { recursive: true, force: true });
      }
    }
    return "installed" as const;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export const installTool = (toolsDir: string, tool: Tool, build: Build) =>
  Effect.tryPromise({
    try: () => install(toolsDir, tool, build),
    catch: (error) =>
      error instanceof ToolRefused
        ? error
        : new Error(`can't install ${tool.name}: ${errorText(error)}`),
  });

export const removeTool = (toolsDir: string, name: string) =>
  Effect.tryPromise({
    try: async () => {
      const folder = join(toolsDir, name);
      const present = await lstat(folder).then(
        () => true,
        () => false,
      );
      await rm(folder, { recursive: true, force: true });
      return present ? ("removed" as const) : ("absent" as const);
    },
    catch: (error) => new Error(`can't remove ${name}: ${errorText(error)}`),
  });
