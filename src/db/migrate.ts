// src/db/migrate.ts
import { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './pool.js';

function getMigrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) {
    return process.env.MIGRATIONS_DIR;
  }
  return path.resolve(process.cwd(), 'migrations');
}

export async function migrate(pool: Pool): Promise<string[]> {
  const dir = getMigrationsDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    
    const applied = await client.query('SELECT filename FROM schema_migrations');
    const appliedSet = new Set(applied.rows.map((r: any) => r.filename));
    
    const newlyApplied: string[] = [];
    
    for (const file of files) {
      if (appliedSet.has(file)) continue;
      
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        newlyApplied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    
    return newlyApplied;
  } finally {
    client.release();
  }
}

const __filename = fileURLToPath(import.meta.url);
const scriptArg = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirectRun = scriptArg === __filename || 
                    scriptArg === __filename.replace(/\.ts$/, '.js') ||
                    scriptArg.endsWith('/migrate.ts') ||
                    scriptArg.endsWith('/migrate.js');

if (isDirectRun) {
  const pool = createPool();
  migrate(pool)
    .then(applied => {
      console.log(`Applied ${applied.length} migration(s):`);
      applied.forEach(f => console.log(`  ${f}`));
      return pool.end();
    })
    .catch(err => {
      console.error('Migration failed:', err);
      pool.end().then(() => process.exit(1));
    });
}