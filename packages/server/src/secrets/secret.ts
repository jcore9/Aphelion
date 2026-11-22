import { maskSecretValue, redactSelf, unmaskSecretValue } from "../log";

const inspectCustom = Symbol.for("nodejs.util.inspect.custom");

export class SecretSerializationError extends Error {
  override name = "SecretSerializationError";

  constructor() {
    super(
      "A Secret can't be serialized. Pass the Secret itself, and call reveal() only where the value is used.",
    );
  }
}

export class SecretWipedError extends Error {
  override name = "SecretWipedError";

  constructor() {
    super("This Secret was wiped, so its value can't be read.");
  }
}

export interface SecretOptions {
  readonly label?: string;
}

export class Secret {
  readonly label: string | undefined;
  #value: string | undefined;

  private constructor(value: string, label: string | undefined) {
    this.#value = value;
    this.label = label;
  }

  static make(value: string, { label }: SecretOptions = {}): Secret {
    maskSecretValue(value);
    return new Secret(value, label);
  }

  // An own function property makes structuredClone throw a DataCloneError,
  // so a Secret can't cross a worker or process pipe that clones its messages.
  readonly reveal = (): string => {
    if (this.#value === undefined) throw new SecretWipedError();
    return this.#value;
  };

  get wiped(): boolean {
    return this.#value === undefined;
  }

  wipe(): void {
    if (this.#value === undefined) return;
    unmaskSecretValue(this.#value);
    this.#value = undefined;
  }

  toString(): string {
    return this.label === undefined ? "<redacted>" : `<redacted:${this.label}>`;
  }

  toJSON(): never {
    throw new SecretSerializationError();
  }

  [redactSelf](): string {
    return this.toString();
  }

  [inspectCustom](): string {
    return this.toString();
  }
}
