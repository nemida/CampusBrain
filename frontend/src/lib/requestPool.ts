/** Share concurrent reads only; settled results are never cached. */
export class RequestPool {
  private readonly pending = new Map<string, Promise<unknown>>();

  run<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const request = Promise.resolve()
      .then(load)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }
}
