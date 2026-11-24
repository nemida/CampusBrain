/** Bounded expiring cache. Overlapping batches share work; failed loads remain retryable. */
export class AsyncBatchCache<T> {
  private readonly values = new Map<string, { value: T; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<T>>();

  constructor(
    private readonly capacity = 512,
    private readonly ttlMs = 30 * 60_000,
  ) {}

  async getMany(
    keys: string[],
    loader: (missing: string[]) => Promise<T[]>,
  ): Promise<T[]> {
    const now = Date.now();
    const missing = new Map<
      string,
      { resolve: (value: T) => void; reject: (reason: unknown) => void }
    >();
    const results = keys.map((key) => {
      const cached = this.values.get(key);
      if (cached && cached.expiresAt > now) {
        this.values.delete(key);
        this.values.set(key, cached);
        return Promise.resolve(cached.value);
      }
      this.values.delete(key);
      const pending = this.pending.get(key);
      if (pending) return pending;
      const promise = new Promise<T>((resolve, reject) =>
        missing.set(key, { resolve, reject }),
      );
      this.pending.set(key, promise);
      return promise;
    });
    if (missing.size) {
      const newKeys = [...missing.keys()];
      void Promise.resolve()
        .then(() => loader(newKeys))
        .then((loaded) => {
          if (loaded.length !== newKeys.length)
            throw new Error("Batch loader returned an unexpected result count");
          newKeys.forEach((key, index) => {
            const value = loaded[index]!;
            this.pending.delete(key);
            if (this.capacity > 0) {
              this.values.set(key, {
                value,
                expiresAt: Date.now() + this.ttlMs,
              });
              while (this.values.size > this.capacity)
                this.values.delete(this.values.keys().next().value!);
            }
            missing.get(key)!.resolve(value);
          });
        })
        .catch((error: unknown) => {
          for (const [key, deferred] of missing) {
            this.pending.delete(key);
            deferred.reject(error);
          }
        });
    }
    return Promise.all(results);
  }
}
