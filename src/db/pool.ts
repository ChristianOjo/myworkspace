// src/db/pool.ts
import { Pool } from 'pg';

export function createPool(url?: string, options?: { max?: number }): Pool {
  const connectionString = url || process.env.DATABASE_URL || 'postgres://myworkspace:myworkspace@localhost:5432/myworkspace';
  return new Pool({
    connectionString,
    max: options?.max,
  });
}

export function createAppPool(url?: string, max?: number): Pool {
  const connectionString = url || process.env.APP_DATABASE_URL || 'postgres://app_user:app_user@localhost:5432/myworkspace';
  return new Pool({
    connectionString,
    max,
  });
}