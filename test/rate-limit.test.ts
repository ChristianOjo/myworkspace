import { describe, it, expect } from 'vitest';
import { LoginLimiter } from '../src/http/rateLimit.js';

describe('rate-limit', () => {
  it('blocks an account after 5 failures from one ip', () => {
    let clock = new Date('2030-01-07T09:00:00Z');
    const limiter = new LoginLimiter({ now: () => clock });
    const ip = '1.2.3.4';
    const acc = 'org|user';

    for (let i = 0; i < 5; i++) {
      expect(limiter.check(ip, acc).allowed).toBe(true);
      limiter.recordFailure(ip, acc);
    }

    const res = limiter.check(ip, acc);
    expect(res.allowed).toBe(false);
    if (!res.allowed) expect(res.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('other accounts from the same ip are unaffected until the ip limit', () => {
    let clock = new Date('2030-01-07T09:00:00Z');
    const limiter = new LoginLimiter({ now: () => clock });
    const ip = '1.2.3.4';
    const accA = 'org|userA';
    const accB = 'org|userB';

    for (let i = 0; i < 5; i++) {
      limiter.recordFailure(ip, accA);
    }
    expect(limiter.check(ip, accA).allowed).toBe(false);
    expect(limiter.check(ip, accB).allowed).toBe(true);

    for (let i = 0; i < 30; i++) {
      limiter.recordFailure(ip, `org|user${i}`);
    }
    expect(limiter.check(ip, accB).allowed).toBe(false);
  });

  it('failures expire after the window', () => {
    let clock = new Date('2030-01-07T09:00:00Z');
    const limiter = new LoginLimiter({ now: () => clock });
    const ip = '1.2.3.4';
    const acc = 'org|user';

    for (let i = 0; i < 5; i++) {
      limiter.recordFailure(ip, acc);
    }
    expect(limiter.check(ip, acc).allowed).toBe(false);

    clock = new Date('2030-01-07T09:15:01Z');
    expect(limiter.check(ip, acc).allowed).toBe(true);
  });

  it('a success resets the account counter only', () => {
    let clock = new Date('2030-01-07T09:00:00Z');
    const limiter = new LoginLimiter({ now: () => clock });
    const ip = '1.2.3.4';
    const acc = 'org|user';

    for (let i = 0; i < 4; i++) {
      limiter.recordFailure(ip, acc);
    }
    limiter.reset(ip, acc);
    
    for (let i = 0; i < 4; i++) {
      expect(limiter.check(ip, acc).allowed).toBe(true);
      limiter.recordFailure(ip, acc);
    }
    expect(limiter.check(ip, acc).allowed).toBe(true);
  });
});