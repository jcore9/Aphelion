import { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { bunCgroupHost, shippedCgroupHost } from "../adapters/cgroup-host";
import { createLogger } from "../log";
import { pipeLink } from "../plugins/link";
import {
  maxSupervisorFrameBytes,
  supervisorReplySchema,
  supervisorRequestSchema,
  type SupervisorReply,
} from "./protocol";
import { runSupervisor } from "./supervisor";
import { adapterTable } from "./table";

const logger = createLogger({
  write: (line) => process.stderr.write(`${line}\n`),
});

const serve = (
  readable: ReadableStream<Uint8Array>,
  write: (text: string) => Promise<unknown>,
) =>
  Effect.gen(function* () {
    const link = yield* pipeLink(
      readable,
      write,
      {
        schema: supervisorRequestSchema,
        maxBytes: maxSupervisorFrameBytes,
        onDrop: (reason) =>
          Effect.sync(() => {
            logger.warn("the cgroup supervisor dropped a request", { reason });
          }),
      },
      supervisorReplySchema,
    );
    yield* runSupervisor(link, {
      adapters: adapterTable(home),
      logger,
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(bunCgroupHost({ ...shippedCgroupHost, logger })),
  );

const { values } = parseArgs({
  options: {
    probe: { type: "boolean", default: false },
    home: { type: "string", default: "/var/lib/aphelion-bots" },
  },
});
const home = values.home;

if (values.probe) {
  let verdict: SupervisorReply | undefined;
  await Effect.runPromise(
    serve(new Blob([]).stream(), (text) => {
      verdict ??= supervisorReplySchema.parse(JSON.parse(text));
      return Promise.resolve();
    }),
  );
  if (verdict?.type === "ready") {
    process.stdout.write("the cgroup check passed\n");
    process.exit(0);
  }
  const failure =
    verdict?.type === "unsafe"
      ? `${verdict.step}: ${verdict.errno}`
      : "no answer";
  process.stdout.write(`the cgroup check failed at ${failure}\n`);
  process.exit(1);
}

process.stdout.on("error", (error) => {
  logger.error("the cgroup supervisor couldn't write to the bot runner", {
    error: error.message,
  });
});
await Effect.runPromise(
  serve(
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    (text) =>
      new Promise((done) => {
        process.stdout.write(text, () => {
          done(undefined);
        });
      }),
  ),
);
process.exit(0);
