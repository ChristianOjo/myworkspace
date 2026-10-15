import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createScheduler } from '../src/jobs/scheduler.js';

describe('scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tick runs the job and passes errors to onError without throwing', async () => {
    let runCount = 0;
    let errorCaught: unknown = null;
    const scheduler = createScheduler({
      run: async () => {
        runCount++;
        if (runCount === 1) throw new Error('boom');
      },
      intervalMs: 1000,
      onError: (err) => { errorCaught = err; }
    });

    await scheduler.tick();
    expect(runCount).toBe(1);
    expect((errorCaught as Error).message).toBe('boom');

    await scheduler.tick();
    expect(runCount).toBe(2);
  });

  it('overlapping ticks are skipped while a run is in progress', async () => {
    let resolveRun: () => void;
    const runPromise = new Promise<void>(resolve => { resolveRun = resolve; });
    let runCount = 0;

    const scheduler = createScheduler({
      run: async () => {
        runCount++;
        await runPromise;
      },
      intervalMs: 1000
    });

    const p1 = scheduler.tick();
    const p2 = scheduler.tick();
    
    expect(runCount).toBe(1);
    
    resolveRun!();
    await p1;
    await p2;
    
    await scheduler.tick();
    expect(runCount).toBe(2);
  });

  it('start and stop control the timer', async () => {
    let runCount = 0;
    const scheduler = createScheduler({
      run: async () => { runCount++; },
      intervalMs: 1000
    });

    scheduler.start();
    scheduler.start(); // Should not create a second timer
    
    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();
    expect(runCount).toBe(1);

    scheduler.stop();
    scheduler.stop(); // Safe to call twice
    
    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();
    expect(runCount).toBe(1);
  });
});