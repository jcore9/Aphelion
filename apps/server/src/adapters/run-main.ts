import { BunRuntime, BunServices } from "@effect/platform-bun";

export const runMain = BunRuntime.runMain({ disableErrorReporting: true });

export const bunServices = BunServices.layer;
