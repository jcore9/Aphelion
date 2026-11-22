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

const madeByMake = Symbol("Secret.make");
const notCloneable = Symbol("Secret");

export class SecretConstructionError extends TypeError {
  override name = "SecretConstructionError";

  constructor() {
    super("Make a Secret with Secret.make().");
  }
}

export class Secret {
  readonly label: string | undefined;
  // structuredClone refuses a symbol value, so it throws a DataCloneError for
  // a Secret, and a spread or Object.assign copies nothing callable.
  readonly cloneGuard: symbol = notCloneable;
  #value: string | undefined;

  private constructor(
    token: typeof madeByMake,
    value: string,
    label: string | undefined,
  ) {
    if (token !== madeByMake) throw new SecretConstructionError();
    maskSecretValue(value);
    this.#value = value;
    this.label = label;
    Object.freeze(this);
  }

  static make(value: string, { label }: SecretOptions = {}): Secret {
    return new Secret(madeByMake, value, label);
  }

  reveal(): string {
    if (this.#value === undefined) throw new SecretWipedError();
    return this.#value;
  }

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

Object.freeze(Secret.prototype);
Object.freeze(Secret);
