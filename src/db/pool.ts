// src/db/pool.ts
import { Pool } from 'pg';

function getSslConfig(ssl?: 'off' | 'require' | 'no-verify'): any {
  if (ssl === 'require') return true;
  if (ssl === 'no-verify') return { rejectUnauthorized: false };
  return undefined;
}

export function createPool(url?: string, options?: { ssl?: 'off' | 'require' | 'no-verify', max?: number }): Pool {
  const connectionString = url || process.env.DATABASE_URL;
  const max = options?.max || 10;
  const ssl = getSslConfig(options?.ssl);
  
  return new Pool({
    connectionString,
    max,
    ...(ssl !== undefined ? { ssl } : {})
  });
}

export function createAppPool(url: string, optionsOrMax?: number | { ssl?: 'off' | 'require' | 'no-verify', max?: number }): Pool {
  let max = 10;
  let ssl: 'off' | 'require' | 'no-verify' | undefined;
  
  if (typeof optionsOrMax === 'number') {
    max = optionsOrMax;
  } else if (optionsOrMax) {
    if (optionsOrMax.max !== undefined) max = optionsOrMax.max;
    ssl = optionsOrMax.ssl;
  }
  
  const sslConfig = getSslConfig(ssl);
  
  return new Pool({
    connectionString: url,
    max,
    ...(sslConfig !== undefined ? { ssl: sslConfig } : {})
  });
}