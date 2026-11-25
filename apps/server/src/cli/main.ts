import { Effect } from "effect";
import { runMain } from "../adapters/run-main";
import { cli, processIo } from "./index";

cli(process.argv.slice(2)).pipe(Effect.provide(processIo), runMain);
