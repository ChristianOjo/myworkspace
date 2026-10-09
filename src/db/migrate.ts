// myworkspace/src/db/migrate.ts
import { Pool } from 'pg';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function migrate(pool: Pool): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz DEFAULT now()
    )
  `);

  const migrationsDir = join(__dirname, '../../migrations');
  const files = await readdir(migrationsDir);
  const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();

  const appliedRes = await pool.query('SELECT filename FROM schema_migrations');
  const appliedFilenames = new Set(appliedRes.rows.map((r: any) => r.filename));

  const newlyApplied: string[] = [];

  for (const file of sqlFiles) {
    if (!appliedFilenames.has(file)) {
      const filePath = join(migrationsDir, file);
      const sql = await readFile(filePath, 'utf-8');
      
      await pool.query('BEGIN');
      try {
        await pool.query(sql);
        await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await pool.query('COMMIT');
        newlyApplied.push(file);
        console.log(`Applied migration: ${file}`);
      } catch (err) {
        await pool.query('ROLLBACK');
        throw err;
      }
    }
  }

  return newlyApplied;
}

const mainPath = fileURLToPath(import.meta.url).replace(/\\/g, '/');
const argPath = (process.argv[1] || '').replace(/\\/g, '/');

if (argPath === mainPath) {
  const { createPool } = await import('./pool.js');
  const pool = createPool();
  try {
    const applied = await migrate(pool);
    if (applied.length === 0) {
      console.log('No new migrations to apply.');
    }
  } finally {
    await pool.end();
  }
}