import { join } from "node:path";
import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { z } from "zod";
import {
  addDevice,
  defaultLifetimeDays,
  deviceId,
  deviceName,
  lifetimeDays,
  listDevices,
  revokeDevice,
} from "../devices";
import {
  checkedArgument,
  checkedFlag,
  optionalFlag,
  options,
  operands,
  stateDirFlag,
  type Handler,
} from "./flags";
import { openStore, type Database } from "../store";
import { failed } from "./failure";
import { CliIo } from "./io";

export const databaseFile = "aphelion.db";

export const withStore = <A, E, R>(
  stateDir: string,
  use: (db: Database) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => openStore(join(stateDir, databaseFile))),
    use,
    (db) =>
      Effect.sync(() => {
        db.close();
      }),
  );

export const deviceAdd = (options: {
  readonly stateDir: string;
  readonly name: string;
  readonly days: number | undefined;
}) =>
  withStore(options.stateDir, (db) =>
    Effect.gen(function* () {
      const io = yield* CliIo;
      const device = addDevice(db, {
        name: options.name,
        ...(options.days === undefined ? {} : { lifetimeDays: options.days }),
      });
      yield* io.out(device.token).pipe(
        Effect.catch((error) =>
          Effect.andThen(
            Effect.sync(() => revokeDevice(db, device.id)),
            Effect.fail(
              new Error(
                `couldn't print the token (${error.message}), so device ${device.id} was revoked`,
              ),
            ),
          ),
        ),
      );
      yield* io
        .err(
          `Added device "${device.name}" with id ${device.id}. Its token expires at ${device.expiresAt}.`,
        )
        .pipe(Effect.ignore);
      yield* io
        .err(
          "The token is shown once. Copy it to the device now: it can't be shown again.",
        )
        .pipe(Effect.ignore);
    }),
  );

export const deviceList = (options: { readonly stateDir: string }) =>
  withStore(options.stateDir, (db) =>
    Effect.gen(function* () {
      const io = yield* CliIo;
      const now = new Date().toISOString();
      const devices = listDevices(db);
      if (devices.length === 0) {
        yield* io.err("No devices. Add one with: aphelion device add <name>");
        return;
      }
      yield* io.out("ID\tSTATUS\tEXPIRES\tNAME");
      for (const device of devices) {
        const status =
          device.revokedAt !== null
            ? "revoked"
            : device.expiresAt <= now
              ? "expired"
              : "active";
        yield* io.out(
          [
            device.id,
            status,
            device.expiresAt,
            JSON.stringify(device.name),
          ].join("\t"),
        );
      }
    }),
  );

export const deviceRevoke = (options: {
  readonly stateDir: string;
  readonly id: string;
}) =>
  withStore(options.stateDir, (db) =>
    Effect.gen(function* () {
      const io = yield* CliIo;
      if (revokeDevice(db, options.id)) {
        yield* io.err(`Revoked device ${options.id}.`);
        return;
      }
      yield* io.err(
        `No active device has the id ${options.id}. It may be unknown or already revoked.`,
      );
      return yield* failed;
    }),
  );

const deviceLifetime = z
  .string()
  .regex(/^\d+$/, { error: "must be a whole number of days" })
  .transform(Number)
  .pipe(lifetimeDays);

export const deviceAddCommand = (
  handler: Handler<Parameters<typeof deviceAdd>[0]>,
) =>
  Command.make(
    "add",
    {
      stateDir: stateDirFlag,
      name: checkedArgument(operands["device add"], "device name", deviceName),
      days: optionalFlag(
        checkedFlag(options.days, deviceLifetime).pipe(
          Flag.withDescription(
            `Days until the token expires, 1 to 365 (default ${String(defaultLifetimeDays)})`,
          ),
        ),
      ),
    },
    handler,
  ).pipe(
    Command.withDescription(
      "Add a device and print its token once to standard output.",
    ),
  );

export const deviceListCommand = (
  handler: Handler<Parameters<typeof deviceList>[0]>,
) =>
  Command.make("list", { stateDir: stateDirFlag }, handler).pipe(
    Command.withDescription(
      "List devices and whether each token is active, expired or revoked.",
    ),
  );

export const deviceRevokeCommand = (
  handler: Handler<Parameters<typeof deviceRevoke>[0]>,
) =>
  Command.make(
    "revoke",
    {
      stateDir: stateDirFlag,
      id: checkedArgument(operands["device revoke"], "device id", deviceId),
    },
    handler,
  ).pipe(Command.withDescription("Stop a device's token at once."));
