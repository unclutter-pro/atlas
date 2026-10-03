/** Single-consumer bounded queue. Terminal events have one reserved slot. */
export class EventQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private wake?: () => void;
  private ended = false;
  private attached = false;
  constructor(private readonly limit = 4096) {}

  push(value: T): void {
    if (this.ended) return;
    if (this.values.length >= this.limit) throw new Error("Harness event consumer fell behind");
    this.values.push(value);
    this.wake?.();
  }

  finish(value: T): void {
    this.values.push(value);
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    if (this.attached) throw new Error("Harness events allow one consumer");
    this.attached = true;
    while (true) {
      if (this.values.length) yield this.values.shift()!;
      else if (this.ended) return;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}
