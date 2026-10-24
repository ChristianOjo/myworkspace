// test/security-headers.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testPool, appPool } from './helpers.js';
import { buildApp } from '../src/http/app.js';

let tempDir: string;

describe('security-headers', () => {
  it('security headers are on API and static responses', async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'security-test-'));
    writeFileSync(path.join(tempDir, 'index.html'), '<html><body>Test</body></html>');
    
    const app = buildApp({ pool: appPool, staticDir: tempDir });
    
    const apiRes = await app.inject({ method: 'GET', url: '/health' });
    expect(apiRes.headers['x-frame-options']).toBe('DENY');
    expect(apiRes.headers['x-content-type-options']).toBe('nosniff');
    expect(apiRes.headers['referrer-policy']).toBe('no-referrer');
    expect(apiRes.headers['permissions-policy']).toBeDefined();
    
    const htmlRes = await app.inject({ method: 'GET', url: '/' });
    expect(htmlRes.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    
    await app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('strict transport security only in production mode', async () => {
    const appDev = buildApp({ pool: appPool, production: false });
    const resDev = await appDev.inject({ method: 'GET', url: '/health' });
    expect(resDev.headers['strict-transport-security']).toBeUndefined();
    await appDev.close();
    
    const appProd = buildApp({ pool: appPool, production: true });
    const resProd = await appProd.inject({ method: 'GET', url: '/health' });
    expect(resProd.headers['strict-transport-security']).toContain('max-age');
    await appProd.close();
  });
});