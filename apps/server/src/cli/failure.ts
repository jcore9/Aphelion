import { Data, Runtime } from "effect";

export class CliFailure extends Data.TaggedError("CliFailure")<{
  readonly exitCode: 1 | 2;
}> {
  override get [Runtime.errorExitCode](): number {
    return this.exitCode;
  }
}

export const failed = new CliFailure({ exitCode: 1 });
export const usage = new CliFailure({ exitCode: 2 });
