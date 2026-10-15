interface CounterMap {
  timestamps: number[];
}

export class LoginLimiter {
  private now: () => Date;
  private windowMs: number;
  private maxPerAccount: number;
  private maxPerIp: number;
  private accountCounters: Map<string, CounterMap>;
  private ipCounters: Map<string, CounterMap>;

  constructor(opts: { now: () => Date; windowMs?: number; maxPerAccount?: number; maxPerIp?: number }) {
    this.now = opts.now;
    this.windowMs = opts.windowMs ?? 15 * 60 * 1000;
    this.maxPerAccount = opts.maxPerAccount ?? 5;
    this.maxPerIp = opts.maxPerIp ?? 30;
    this.accountCounters = new Map();
    this.ipCounters = new Map();
  }

  private prune(counters: CounterMap, currentTime: number): void {
    while (counters.timestamps.length > 0 && counters.timestamps[0] <= currentTime - this.windowMs) {
      counters.timestamps.shift();
    }
  }

  check(ip: string, accountKey: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const currentTime = this.now().getTime();
    
    const accKey = `${ip}|${accountKey}`;
    let accCounter = this.accountCounters.get(accKey);
    if (!accCounter) {
      accCounter = { timestamps: [] };
      this.accountCounters.set(accKey, accCounter);
    }
    this.prune(accCounter, currentTime);

    let ipCounter = this.ipCounters.get(ip);
    if (!ipCounter) {
      ipCounter = { timestamps: [] };
      this.ipCounters.set(ip, ipCounter);
    }
    this.prune(ipCounter, currentTime);

    if (accCounter.timestamps.length >= this.maxPerAccount) {
      const oldest = accCounter.timestamps[0];
      const retryAfter = Math.ceil((oldest + this.windowMs - currentTime) / 1000);
      return { allowed: false, retryAfterSeconds: Math.max(1, retryAfter) };
    }

    if (ipCounter.timestamps.length >= this.maxPerIp) {
      const oldest = ipCounter.timestamps[0];
      const retryAfter = Math.ceil((oldest + this.windowMs - currentTime) / 1000);
      return { allowed: false, retryAfterSeconds: Math.max(1, retryAfter) };
    }

    return { allowed: true };
  }

  recordFailure(ip: string, accountKey: string): void {
    const currentTime = this.now().getTime();
    const accKey = `${ip}|${accountKey}`;
    
    if (!this.accountCounters.has(accKey)) {
      this.accountCounters.set(accKey, { timestamps: [] });
    }
    this.accountCounters.get(accKey)!.timestamps.push(currentTime);

    if (!this.ipCounters.has(ip)) {
      this.ipCounters.set(ip, { timestamps: [] });
    }
    this.ipCounters.get(ip)!.timestamps.push(currentTime);
  }

  reset(ip: string, accountKey: string): void {
    const accKey = `${ip}|${accountKey}`;
    this.accountCounters.delete(accKey);
  }
}