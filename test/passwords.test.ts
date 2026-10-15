import { describe, it, expect, beforeAll } from 'vitest';
import { hashPassword, verifyPassword, validatePassword } from '../src/auth/passwords.js';

beforeAll(() => {
  process.env.SCRYPT_N = '1024';
});

describe('passwords', () => {
  it('hash then verify succeeds and a wrong password fails', async () => {
    const pass = 'correct-horse-battery-staple';
    const hash = await hashPassword(pass);
    expect(await verifyPassword(pass, hash)).toBe(true);
    expect(await verifyPassword('wrong-pass', hash)).toBe(false);
  });

  it('hashes are salted and use the scrypt format', async () => {
    const pass = 'test-password';
    const h1 = await hashPassword(pass);
    const h2 = await hashPassword(pass);
    expect(h1).not.toBe(h2);
    expect(h1).toMatch(/^scrypt\$\d+\$8\$1\$.+\$.+$/);
    expect(h2).toMatch(/^scrypt\$\d+\$8\$1\$.+\$.+$/);
  });

  it('verify rejects malformed and empty hashes without throwing', async () => {
    expect(await verifyPassword('pass', null)).toBe(false);
    expect(await verifyPassword('pass', '')).toBe(false);
    expect(await verifyPassword('pass', 'garbage')).toBe(false);
    expect(await verifyPassword('pass', 'scrypt$x$y$z$a$b')).toBe(false);
    const highNHash = 'scrypt$4194304$8$1$cGFzc3dvcmQ=$cGFzc3dvcmQ=';
    expect(await verifyPassword('pass', highNHash)).toBe(false);
  });

  it('password policy rejects short and overlong passwords', () => {
    expect(validatePassword('short')).toBe('weak_password');
    expect(validatePassword('a'.repeat(201))).toBe('weak_password');
    expect(validatePassword('a'.repeat(10))).toBe(null);
  });
});