import { describe, it, expect } from 'vitest';
import { AiQueue } from './aiQueue.js';

describe('Client-Side Concurrency Queue (AiQueue)', () => {
  it('Limits concurrent tasks to configured limit (concurrency = 2) preventing bursts', async () => {
    const queue = new AiQueue({ concurrency: 2 });
    let currentRunning = 0;
    let peakRunning = 0;
    const completedOrder: number[] = [];

    const makeTask = (id: number, delayMs: number) => async () => {
      currentRunning++;
      peakRunning = Math.max(peakRunning, currentRunning);

      await new Promise((resolve) => setTimeout(resolve, delayMs));

      currentRunning--;
      completedOrder.push(id);
      return `result_${id}`;
    };

    // Enqueue 5 tasks at once
    const promises = [
      queue.enqueue(makeTask(1, 30)),
      queue.enqueue(makeTask(2, 30)),
      queue.enqueue(makeTask(3, 20)),
      queue.enqueue(makeTask(4, 20)),
      queue.enqueue(makeTask(5, 10)),
    ];

    const results = await Promise.all(promises);

    // Peak concurrency must never exceed 2
    expect(peakRunning).toBeLessThanOrEqual(2);
    expect(peakRunning).toBe(2);

    // All tasks completed with results
    expect(results).toEqual([
      'result_1',
      'result_2',
      'result_3',
      'result_4',
      'result_5',
    ]);
    expect(completedOrder.length).toBe(5);
  });

  it('Enforces strict serial execution when concurrency is 1', async () => {
    const serialQueue = new AiQueue({ concurrency: 1 });
    let currentRunning = 0;
    let peakRunning = 0;

    const makeTask = (id: number) => async () => {
      currentRunning++;
      peakRunning = Math.max(peakRunning, currentRunning);
      await new Promise((resolve) => setTimeout(resolve, 15));
      currentRunning--;
      return id;
    };

    const promises = [
      serialQueue.enqueue(makeTask(1)),
      serialQueue.enqueue(makeTask(2)),
      serialQueue.enqueue(makeTask(3)),
    ];

    const results = await Promise.all(promises);

    expect(peakRunning).toBe(1);
    expect(results).toEqual([1, 2, 3]);
  });

  it('Continues processing remaining queued tasks even if one task rejects', async () => {
    const queue = new AiQueue({ concurrency: 1 });

    const task1 = () => Promise.resolve('ok_1');
    const task2 = () => Promise.reject(new Error('task_2_failed'));
    const task3 = () => Promise.resolve('ok_3');

    const p1 = queue.enqueue(task1);
    const p2 = queue.enqueue(task2);
    const p3 = queue.enqueue(task3);

    await expect(p1).resolves.toBe('ok_1');
    await expect(p2).rejects.toThrow('task_2_failed');
    await expect(p3).resolves.toBe('ok_3');
  });
});
