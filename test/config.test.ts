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
});