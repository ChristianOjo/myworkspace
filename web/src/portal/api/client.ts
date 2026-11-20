import type { ApiErrorBody } from './types';

const configuredBase = import.meta.env.VITE_API_BASE_URL;
export const API_BASE_URL = (configuredBase ?? 'http://127.0.0.1:3000').trim().replace(/\/+$/, '');
const API_ROOT = `${API_BASE_URL}/api/v1`;
// Separate storage key so a staff session and a customer session never share a token.
const TOKEN_KEY = 'myworkspace.portal.session';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason?: string;
  readonly retryAfter?: number;

  constructor(status: number, body: ApiErrorBody, retryAfter: number | undefined) {
    super(body.message || 'The request could not be completed.');
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code || 'unknown_error';
    this.reason = body.reason;
    this.retryAfter = retryAfter;
  }
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, { ...init, headers });
  } catch {
    throw new Error(`Can't reach the booking API at ${API_BASE_URL}. Check your connection and try again.`);
  }

  if (response.status === 401 && token) {
    clearToken();
    window.dispatchEvent(new Event('myworkspace-portal:unauthorized'));
  }
  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const body = (payload as { error?: ApiErrorBody } | null)?.error ?? { code: 'unknown_error' };
    const header = response.headers.get('Retry-After');
    throw new ApiError(response.status, body, header ? Number(header) : undefined);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
};
