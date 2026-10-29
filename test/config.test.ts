// test/config.test.ts
import { describe, it, expect } from 'vitest';
import { loadConfig, redactUrl } from '../src/config.js';

describe('config', () => {
  it('development defaults work with no environment variables', () => {
    const config = loadConfig({});
    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.host).toBe('127.0.0.1');
    expect(config.databaseUrl).toBe('');
    expect(config.appDatabaseUrl).toBe('');
    expect(config.dbSsl).toBe('off');
    expect(config.dbPoolMax).toBe(10);
    expect(config.corsOrigins).toEqual([]);
    expect(config.trustProxy).toBe(false);
    expect(config.staticDir).toBeUndefined();
    expect(config.schedulerEnabled).toBe(true);
  });

  it('production rejects missing or default database settings and lists every problem', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/APP_DATABASE_URL is missing/);
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL is missing/);
    
    const err = (() => {
      try {
        loadConfig({ NODE_ENV: 'production' });
      } catch (e: any) {
        return e;
      }
    })();
    expect(err.message).toContain('APP_DATABASE_URL is missing');
    expect(err.message).toContain('DATABASE_URL is missing');
    expect(err.message).not.toContain('password');
    
    expect(() => loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://owner:secret@host/db',
      APP_DATABASE_URL: 'postgres://app_user:app_user@host/db'
    })).toThrow(/APP_DATABASE_URL still contains the default development credentials/);
  });

  it('production rejects wildcard origins, identical urls and a missing origin and static dir', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://owner:secret@host/db',
      APP_DATABASE_URL: 'postgres://app:secret@host/db',
      CORS_ORIGINS: '*'
    })).toThrow(/CORS_ORIGINS must not contain wildcard/);

    expect(() => loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://owner:secret@host/db',
      APP_DATABASE_URL: 'postgres://owner:secret@host/db'
    })).toThrow(/DATABASE_URL and APP_DATABASE_URL must be different/);

    expect(() => loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://owner:secret@host/db',
      APP_DATABASE_URL: 'postgres://app:secret@host/db'
    })).toThrow(/At least one of CORS_ORIGINS or STATIC_DIR must be set/);
  });

  it('a valid production environment loads, parses origins and masks passwords in redactUrl', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://owner:secret@host/db',
      APP_DATABASE_URL: 'postgres://app:secret@host/db',
      CORS_ORIGINS: 'http://localhost:5173, https://example.com'
    });
    expect(config.corsOrigins).toEqual(['http://localhost:5173', 'https://example.com']);
    
    expect(redactUrl('postgres://u:secret@h/db')).toBe('postgres://u:***@h/db');
  });

  it('builds the app database url from parts', () => {
    const config = loadConfig({
      APP_DB_HOST: 'db.internal',
      APP_DB_PORT: '5432',
      APP_DB_NAME: 'mw',
      APP_USER_PASSWORD: 'p+a/s=s w'
    });
    expect(config.appDatabaseUrl).toBe('postgres://app_user:p%2Ba%2Fs%3Ds%20w@db.internal:5432/mw');
  });

  it('an explicit app database url wins over the parts', () => {
    const config = loadConfig({
      APP_DATABASE_URL: 'postgres://explicit:pass@host/db',
      APP_DB_HOST: 'db.internal',
      APP_DB_PORT: '5432',
      APP_DB_NAME: 'mw',
      APP_USER_PASSWORD: 'p+a/s=s w'
    });
    expect(config.appDatabaseUrl).toBe('postgres://explicit:pass@host/db');
  });

  it('production rejects when neither the url nor the parts are given, without leaking a password', () => {
    const err = (() => {
      try {
        loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://owner:secret@host/db' });
      } catch (e: any) {
        return e;
      }
    })();
    expect(err.message).toContain('APP_DATABASE_URL is missing');
    expect(err.message).not.toContain('secret');
  });

  it('migrate on start and bootstrap settings are parsed', () => {
    const config1 = loadConfig({ RUN_MIGRATIONS_ON_START: 'true' });
    expect(config1.migrateOnStart).toBe(true);
    
    const config2 = loadConfig({
      BOOTSTRAP_ORG_NAME: 'Test Org',
      BOOTSTRAP_ORG_SLUG: 'test-org',
      BOOTSTRAP_ADMIN_EMAIL: 'admin@test.com',
      BOOTSTRAP_ADMIN_NAME: 'Admin',
      BOOTSTRAP_ADMIN_PASSWORD: 'password123456'
    });
    expect(config2.bootstrap).toEqual({
      orgName: 'Test Org',
      slug: 'test-org',
      adminEmail: 'admin@test.com',
      adminName: 'Admin',
      adminPassword: 'password123456',
      timezone: 'UTC'
    });
  });

  it('partial bootstrap settings list every missing name and never print the password', () => {
    const password = 'supersecretpassword123';
    const err = (() => {
      try {
        loadConfig({
          BOOTSTRAP_ORG_SLUG: 'test',
          BOOTSTRAP_ADMIN_PASSWORD: password
        });
      } catch (e: any) {
        return e;
      }
    })();
    expect(err.message).toContain('BOOTSTRAP_ORG_NAME');
    expect(err.message).toContain('BOOTSTRAP_ADMIN_EMAIL');
    expect(err.message).toContain('BOOTSTRAP_ADMIN_NAME');
    expect(err.message).not.toContain(password);
  });
});