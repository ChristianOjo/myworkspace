// test/static.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testPool, appPool } from './helpers.js';
import { buildApp } from '../src/http/app.js';

let tempDir: string;
let app: any;

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'static-test-'));
  writeFileSync(path.join(tempDir, 'index.html'), '<html><body>Test</body></html>');
  mkdirSync(path.join(tempDir, 'assets'));
  writeFileSync(path.join(tempDir, 'assets', 'app.abc123.js'), 'console.log("test")');
  writeFileSync(path.join(tempDir, 'assets', 'app.css'), 'body { color: red; }');
  writeFileSync(path.join(tempDir, 'favicon.ico'), 'fake ico');
  
  app = buildApp({ pool: appPool, staticDir: tempDir });
});

afterAll(async () => {
  await app.close();
  rmSync(tempDir, { recursive: true, force: true });
  await appPool.end();
});

describe('static', () => {
  it('serves index.html at the root with no-cache', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain('<html>');
  });

  it('falls back to index.html for app routes', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/calendar' });
    expect(res1.statusCode).toBe(200);
    expect(res1.body).toContain('<html>');
    
    const res2 = await app.inject({ method: 'GET', url: '/cash' });
    expect(res2.statusCode).toBe(200);
    expect(res2.body).toContain('<html>');
  });

  it('hashed assets are cached for a year, other files are not', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/assets/app.abc123.js' });
    expect(res1.statusCode).toBe(200);
    expect(res1.headers['content-type']).toContain('javascript');
    expect(res1.headers['cache-control']).toContain('max-age=31536000');
    expect(res1.headers['cache-control']).toContain('immutable');
    
    const res2 = await app.inject({ method: 'GET', url: '/favicon.ico' });
    expect(res2.statusCode).toBe(200);
    expect(res2.headers['cache-control']).toBe('no-cache');
  });

  it('api routes and health are not shadowed', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res1.statusCode).toBe(404);
    expect(res1.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
    
    const res2 = await app.inject({ method: 'GET', url: '/health' });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toEqual({ status: 'ok' });
    
    const res3 = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res3.headers['cache-control']).toBe('no-store');
  });

  it('path traversal is refused', async () => {
    const paths = [
      '/..%2f..%2fetc%2fpasswd',
      '/%2e%2e/package.json',
      '/assets/..%5c..%5cpackage.json',
      '/test%00.html'
    ];
    
    for (const p of paths) {
      const res = await app.inject({ method: 'GET', url: p });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
      expect(res.body).not.toContain('root:');
    }
  });

  it('missing files that look like files return the JSON 404, HEAD works', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/assets/missing.js' });
    expect(res1.statusCode).toBe(404);
    expect(res1.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
    
    const res2 = await app.inject({ method: 'HEAD', url: '/' });
    expect(res2.statusCode).toBe(200);
    expect(res2.body).toBe('');
  });
});