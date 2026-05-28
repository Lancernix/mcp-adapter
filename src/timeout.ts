// timeout.ts - Timeout helper for @lancernix/mcp-adapter

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  if (ms <= 0) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(message));
    }, ms);

    timer.unref();
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
