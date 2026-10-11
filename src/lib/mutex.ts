// Serialises async work so nonce allocation, guard checks and submission of
// one write cannot interleave with another.
export type Mutex = <T>(work: () => Promise<T>) => Promise<T>;

export const createMutex = (): Mutex => {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  };
};
