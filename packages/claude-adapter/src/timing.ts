export interface Wait<T> {
  readonly done: Promise<T>;
  stop(): void;
}

export function after<T>(ms: number, value: T): Wait<T> {
  let id: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<T>((resolve) => {
    id = setTimeout(() => {
      resolve(value);
    }, ms);
  });
  return {
    done,
    stop: () => {
      clearTimeout(id);
    },
  };
}

export function whenAborted<T>(signal: AbortSignal, value: T): Wait<T> {
  let stop: () => void = () => undefined;
  const done = new Promise<T>((resolve) => {
    if (signal.aborted) {
      resolve(value);
      return;
    }
    const onAbort = () => {
      resolve(value);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    stop = () => {
      signal.removeEventListener("abort", onAbort);
    };
  });
  return {
    done,
    stop: () => {
      stop();
    },
  };
}

export async function unlessAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T | undefined> {
  const aborted = whenAborted(signal, undefined);
  try {
    return await Promise.race([work, aborted.done]);
  } finally {
    aborted.stop();
  }
}

export async function settlesWithin(
  work: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  const limit = after(ms, false);
  try {
    return await Promise.race([work.then(() => true), limit.done]);
  } finally {
    limit.stop();
  }
}
