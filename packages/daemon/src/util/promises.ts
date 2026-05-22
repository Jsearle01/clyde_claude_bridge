// Promise utilities for two recurring shapes in this codebase:
//   1. Node-style callback APIs that signal completion via `(err) => void`
//      (e.g. `socket.write(line, cb)`, `server.close(cb)`).
//   2. Pairs of EventEmitter events where one is success and the other is
//      failure (e.g. `server.once("listening" | "error", ...)`).
//
// These are infrastructure helpers for new code starting T-0009. The five
// inline call sites in T-0007 (audit log) and T-0008 (IPC server) are not
// refactored — refactor-for-its-own-sake violates the project's "do exactly
// what was asked" disposition.

export function promisifyCallback(
  work: (cb: (err: Error | null | undefined) => void) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    work((err) => {
      if (err === null || err === undefined) resolve();
      else reject(err);
    });
  });
}

export function onceOrError<T = void>(
  emitter: NodeJS.EventEmitter,
  successEvent: string,
  errorEvent: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onSuccess = (...args: unknown[]): void => {
      emitter.off(errorEvent, onError);
      resolve(args[0] as T);
    };
    const onError = (...args: unknown[]): void => {
      emitter.off(successEvent, onSuccess);
      const err = args[0];
      if (err instanceof Error) {
        reject(err);
      } else if (err === undefined) {
        reject(new Error(`${errorEvent} fired with no payload`));
      } else if (typeof err === "string") {
        reject(new Error(err));
      } else {
        reject(new Error(`${errorEvent} fired with non-Error payload`));
      }
    };
    emitter.once(successEvent, onSuccess);
    emitter.once(errorEvent, onError);
  });
}
