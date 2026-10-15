import crypto from 'node:crypto';

const DUMMY_HASH_CACHE = { value: null as string | null };

function getDummyHash(): Promise<string> {
  if (!DUMMY_HASH_CACHE.value) {
    // Generate a dummy hash with small N for speed in tests/login timing
    return hashPassword('dummy-password-for-timing', { N: 1024 }).then(h => {
      DUMMY_HASH_CACHE.value = h;
      return h;
    });
  }
  return Promise.resolve(DUMMY_HASH_CACHE.value!);
}

export async function hashPassword(password: string, opts?: { N?: number }): Promise<string> {
  const N = opts?.N ?? Number(process.env.SCRYPT_N ?? 16384);
  const r = 8;
  const p = 1;
  const salt = crypto.randomBytes(16);
  
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N, r, p }, (err, derivedKey) => {
      if (err) return reject(err);
      const hashStr = `${N}$${r}$${p}$${salt.toString('base64')}$${derivedKey.toString('base64')}`;
      resolve(`scrypt$${hashStr}`);
    });
  });
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const N = parseInt(nStr, 10);
  const r = parseInt(rStr, 10);
  const p = parseInt(pStr, 10);
  
  if (isNaN(N) || isNaN(r) || isNaN(p)) return false;
  if (N < 2 || N > 131072) return false;
  
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expectedHash = Buffer.from(hashB64, 'base64');
    
    return new Promise((resolve) => {
      crypto.scrypt(password, salt, 64, { N, r, p }, (err, derivedKey) => {
        if (err) return resolve(false);
        resolve(crypto.timingSafeEqual(expectedHash, derivedKey));
      });
    });
  } catch {
    return false;
  }
}

export function validatePassword(password: unknown): null | 'weak_password' {
  if (typeof password !== 'string') return 'weak_password';
  if (password.length < 10 || password.length > 200) return 'weak_password';
  return null;
}

export function generatePassword(): string {
  return crypto.randomBytes(15).toString('base64url').slice(0, 20);
}

export async function loginVerifyTimingSafe(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    await getDummyHash().then(dummy => verifyPassword(password, dummy));
    return false;
  }
  return verifyPassword(password, stored);
}