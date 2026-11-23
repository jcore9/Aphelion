import { Data } from "effect";

export class UpdateRefused extends Data.TaggedError("UpdateRefused")<{
  readonly reason: string;
}> {}
