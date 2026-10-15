import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, appPool } from './helpers.js';
import { buildApp } from '../src/http/app.js';

beforeEach(async () => {
  await testPool.query('TRUNCATE organizations CASCADE');
});

afterAll(async () => {
  await appPool.end();
});

describe('cors', () => {
  it('an allowed origin gets CORS headers', async () => {
    const app = buildApp({ pool: appPool, corsOrigins: ['http://localhost:5173'] });
    const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://localhost:5173' } });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['vary']).toContain('Origin');
    await app.close();
  });

  it('an unlisted origin gets no CORS headers', async () => {
    const app = buildApp({ pool: appPool, corsOrigins: ['http://localhost:5173'] });
    const res1 = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://evil.example' } });
    expect(res1.headers['access-control-allow-origin']).toBeUndefined();
    
    const res2 = await app.inject({ method: 'GET', url: '/health' });
    expect(res2.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('preflight is answered for allowed origins', async () => {
    const app = buildApp({ pool: appPool, corsOrigins: ['http://localhost:5173'] });
    
    const resAllowed = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/bookings',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' }
    });
    expect(resAllowed.statusCode).toBe(204);
    expect(resAllowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(resAllowed.headers['access-control-allow-methods']).toContain('POST');
    expect(resAllowed.headers['access-control-allow-headers']).toContain('Authorization');
    expect(resAllowed.headers['access-control-max-age']).toBe('600');

    const resUnlisted = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/bookings',
      headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' }
    });
    expect(resUnlisted.statusCode).toBe(204);
    expect(resUnlisted.headers['access-control-allow-origin']).toBeUndefined();
    
    await app.close();
  });

  it('a wildcard origin is refused at startup', () => {
    expect(() => buildApp({ pool: appPool, corsOrigins: ['*'] })).toThrow();
  });
});