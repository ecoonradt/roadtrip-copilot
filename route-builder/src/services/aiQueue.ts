export type AsyncTask<T> = () => Promise<T>;

export interface AiQueueOptions {
  concurrency?: number;
}

export class AiQueue {
  private readonly concurrency: number;
  private running = 0;
  private queue: Array<{
    task: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }> = [];

  constructor(options: AiQueueOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 2);
  }

  get runningCount(): number {
    return this.running;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get maxConcurrency(): number {
    return this.concurrency;
  }

  enqueue<T>(task: AsyncTask<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        task: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.processNext();
    });
  }

  private processNext(): void {
    if (this.running >= this.concurrency || this.queue.length === 0) {
      return;
    }

    const nextItem = this.queue.shift();
    if (!nextItem) {
      return;
    }

    this.running++;

    nextItem
      .task()
      .then((result) => {
        nextItem.resolve(result);
      })
      .catch((error: unknown) => {
        nextItem.reject(error);
      })
      .finally(() => {
        this.running--;
        this.processNext();
      });
  }

  clear(): void {
    this.queue = [];
  }
}

export const defaultAiQueue = new AiQueue({ concurrency: 2 });
