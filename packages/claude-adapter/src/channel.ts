export interface Channel<T> {
  push(item: T): void;
  end(): void;
  take(): T | undefined;
  ready(): Promise<void>;
  readonly ended: boolean;
}

export function channel<T>(): Channel<T> {
  const items: T[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  return {
    push(item) {
      if (ended) return;
      items.push(item);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    take: () => items.shift(),
    ready: () =>
      items.length > 0 || ended
        ? Promise.resolve()
        : new Promise((resolve) => {
            wake = resolve;
          }),
    get ended() {
      return ended;
    },
  };
}

export async function* drain<T>(source: Channel<T>): AsyncGenerator<T> {
  for (;;) {
    await source.ready();
    const item = source.take();
    if (item !== undefined) yield item;
    else if (source.ended) return;
  }
}
