export function lineQueue() {
  const queued: string[] = [];
  let waiting: ((next: IteratorResult<string, undefined>) => void) | undefined;
  let ended = false;
  const end = () => {
    ended = true;
    waiting?.({ done: true, value: undefined });
    waiting = undefined;
  };
  const iterator: AsyncIterator<string, undefined> = {
    next: () => {
      const line = queued.shift();
      if (line !== undefined)
        return Promise.resolve({ done: false, value: line });
      if (ended) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    return: () => {
      end();
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  const pushLine = (line: string) => {
    if (ended) return;
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve({ done: false, value: line });
    } else {
      queued.push(line);
    }
  };
  return {
    push: (message: unknown) => {
      pushLine(JSON.stringify(message));
    },
    pushLine,
    end,
    input: { [Symbol.asyncIterator]: () => iterator },
  };
}
