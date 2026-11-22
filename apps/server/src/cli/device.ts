import { join } from "node:path";
import { Effect } from "effect";
import { addDevice, listDevices, revokeDevice } from "../devices";
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
      yield* io.err(
        `Added device "${device.name}" with id ${device.id}. Its token expires at ${device.expiresAt}.`,
      );
      yield* io.err(
        "The token is printed below, once. Copy it to the device now: it can't be shown again.",
      );
      yield* io.out(device.token);
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
