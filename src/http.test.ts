import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { Prisma } from '../generated/prisma/client';
import app from './index';
import { signToken } from './lib/jwt';
import { errorHandler } from './middlewares/error.middleware';

// End-to-end through the real Hono app (routing, auth, validation, error handler). Nothing
// here writes data: every request is either refused before it reaches the database or is a
// read-only list.

const call = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init));

const bearer = (role: 'PM' | 'INTERNAL' | 'CLIENT') => ({
  Authorization: `Bearer ${signToken({ sub: 'http-test-user', email: '', role })}`,
});

const post = (path: string, body: string | undefined, headers: Record<string, string> = {}) =>
  call(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });

const list = (query: Record<string, string>, role: 'PM' | 'INTERNAL' | 'CLIENT' = 'PM') =>
  call(`/api/tasks?${new URLSearchParams(query)}`, { headers: bearer(role) });

async function errorOf(res: Response) {
  expect(res.headers.get('content-type')).toContain('application/json');
  return ((await res.json()) as { error: string }).error;
}

describe('unknown routes', () => {
  test('answer with the JSON error shape, not plain text', async () => {
    const res = await call('/api/nope');
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe('Not found');
  });
});

describe('malformed request bodies', () => {
  test.each([
    ['broken JSON', '{"email": '],
    ['an empty body', ''],
    ['plain text', 'hello'],
  ])('%s is a 422, not a server error', async (_label, body) => {
    const res = await post('/api/auth/login', body);
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toBe('Request body must be valid JSON');
  });

  test('a body of the wrong shape is still a 422', async () => {
    const res = await post('/api/auth/login', JSON.stringify({ email: 'not-an-email' }));
    expect(res.status).toBe(422);
  });
});

describe('list query parameters', () => {
  test.each([
    ['an unknown orderRule', { orderKey: 'title', orderRule: 'sideways' }],
    ['filters that are not JSON', { filters: '{broken' }],
    ['a filter on a column that is not exposed', { filters: '{"password":"x"}' }],
    ['a search on an enum column', { searchFilters: '{"status":"TO"}' }],
    ['a value of the wrong type for the column', { filters: '{"isClientVisible":"yes"}' }],
    ['a value that is not a member of the enum', { filters: '{"status":"NOPE"}' }],
  ])('%s is a 422, not a server error', async (_label, query) => {
    const res = await list(query);
    expect(res.status).toBe(422);
    await errorOf(res);
  });

  test('a Client Guest cannot probe masked columns through filters', async () => {
    const res = await list({ filters: '{"department":"BACKEND"}' }, 'CLIENT');
    expect(res.status).toBe(422);
  });

  test('a valid query still works', async () => {
    const res = await list({ filters: '{"status":"TODO"}', orderKey: 'createdAt', rows: '1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('entries');
  });
});

describe('registration', () => {
  test('a PM cannot be self-registered', async () => {
    const res = await post(
      '/api/auth/register',
      JSON.stringify({
        email: `http-${Date.now()}@test.local`,
        password: 'password123',
        name: 'Nobody',
        role: 'PM',
      }),
    );
    expect(res.status).toBe(403);
    await errorOf(res);
  });
});

describe('error handler', () => {
  const failing = (error: unknown) => {
    const probe = new Hono();
    probe.get('/', () => {
      throw error;
    });
    probe.onError(errorHandler);
    return probe.request('/');
  };

  const known = (code: string) =>
    new Prisma.PrismaClientKnownRequestError('internal detail: users_email_key', {
      code,
      clientVersion: 'test',
    });

  test.each([
    ['P2002', 409],
    ['P2003', 422],
    ['P2025', 404],
  ])('maps Prisma %s to %d', async (code, status) => {
    const res = await failing(known(code));
    expect(res.status).toBe(status);
    expect(await errorOf(res)).not.toContain('users_email_key');
  });

  test('maps a Prisma validation error to 422 without echoing the query', async () => {
    const res = await failing(
      new Prisma.PrismaClientValidationError('Invalid `prisma.task.findMany()` invocation', {
        clientVersion: 'test',
      }),
    );
    expect(res.status).toBe(422);
    expect(await errorOf(res)).not.toContain('findMany');
  });

  test('keeps everything else a generic 500', async () => {
    const res = await failing(known('P2000'));
    expect(res.status).toBe(500);
    expect(await errorOf(res)).toBe('Internal server error');
  });
});
