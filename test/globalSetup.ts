// myworkspace/test/globalSetup.ts
import { Pool } from 'pg';
import { migrate } from '../src/db/migrate.js';

export async function setup() {
  const pool = new Pool({
    connectionString: 'postgres://myworkspace:myworkspace@localhost:5432/postgres',
  });
  try {
    await pool.query('DROP DATABASE IF EXISTS myworkspace_test WITH (FORCE)');
    await pool.query('CREATE DATABASE myworkspace_test');
  } finally {
    await pool.end();
  }

  const testPool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL || 'postgres://myworkspace:myworkspace@localhost:5432/myworkspace_test',
  });
  await migrate(testPool);
  await testPool.end();
}

export default setup;