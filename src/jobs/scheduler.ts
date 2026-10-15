export interface Scheduler {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

export function createScheduler(opts: { 
  run: () => Promise<unknown>; 
  intervalMs: number; 
  onError?: (err: unknown) => void 
}): Scheduler {
  let timer: NodeJS.Timeout | null = null;
  let isRunning = false;

  const tick = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await opts.run();
    } catch (err) {
      if (opts.onError) {
        opts.onError(err);
      }
    } finally {
      isRunning = false;
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, opts.intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick
  };
}