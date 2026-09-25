import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { registerSchema } from '../dto/auth.dto';
import { ForbiddenError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { register } from './auth.service';

// Namespaced so repeated runs against a real dev database never collide with seed data.
const RUN = `auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const emailFor = (label: string) => `${RUN}-${label}@test.local`;

const base = { password: 'password123', name: 'Test User' } as const;

describe('register — role gate', () => {
  const original = process.env.PM_SIGNUP_CODE;

  beforeEach(() => {
    delete process.env.PM_SIGNUP_CODE;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.PM_SIGNUP_CODE;
    else process.env.PM_SIGNUP_CODE = original;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: `${RUN}-` } } });
  });

  const exists = async (email: string) =>
    (await prisma.user.findUnique({ where: { email } })) !== null;

  test('anyone can register as a Client Guest', async () => {
    const email = emailFor('client');
    const { user } = await register({ ...base, email, role: 'CLIENT' });
    expect(user.role).toBe('CLIENT');
  });

  test('anyone can register as Internal Team — membership, not the role, grants access', async () => {
    const email = emailFor('internal');
    const { user } = await register({ ...base, email, role: 'INTERNAL', department: 'BACKEND' });
    expect(user.role).toBe('INTERNAL');
    expect(user.department).toBe('BACKEND');
  });

  test('a PM cannot be self-registered when no invite code is configured', async () => {
    const email = emailFor('pm-unconfigured');
    await expect(register({ ...base, email, role: 'PM' })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await exists(email)).toBe(false);
  });

  test('a supplied code does not help when none is configured (fails closed)', async () => {
    const email = emailFor('pm-empty-config');
    process.env.PM_SIGNUP_CODE = '';
    await expect(register({ ...base, email, role: 'PM', inviteCode: '' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await exists(email)).toBe(false);
  });

  test('a PM registration without the code is refused', async () => {
    const email = emailFor('pm-missing-code');
    process.env.PM_SIGNUP_CODE = 'correct-horse-battery';
    await expect(register({ ...base, email, role: 'PM' })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await exists(email)).toBe(false);
  });

  test('a PM registration with the wrong code is refused', async () => {
    const email = emailFor('pm-wrong-code');
    process.env.PM_SIGNUP_CODE = 'correct-horse-battery';
    await expect(
      register({ ...base, email, role: 'PM', inviteCode: 'correct-horse-batterX' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await exists(email)).toBe(false);
  });

  test('a PM registration with a code of a different length is refused', async () => {
    const email = emailFor('pm-short-code');
    process.env.PM_SIGNUP_CODE = 'correct-horse-battery';
    await expect(
      register({ ...base, email, role: 'PM', inviteCode: 'correct' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test('a PM registration with the right code succeeds', async () => {
    const email = emailFor('pm-ok');
    process.env.PM_SIGNUP_CODE = 'correct-horse-battery';
    const { user, token } = await register({
      ...base,
      email,
      role: 'PM',
      inviteCode: 'correct-horse-battery',
    });
    expect(user.role).toBe('PM');
    expect(token).toBeString();
  });

  test('the invite code is never stored on the user', async () => {
    const email = emailFor('pm-not-stored');
    process.env.PM_SIGNUP_CODE = 'correct-horse-battery';
    await register({ ...base, email, role: 'PM', inviteCode: 'correct-horse-battery' });
    const stored = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(JSON.stringify(stored)).not.toContain('correct-horse-battery');
  });
});

describe('registerSchema', () => {
  test('accepts an optional invite code', () => {
    const parsed = registerSchema.parse({
      ...base,
      email: 'a@b.co',
      role: 'PM',
      inviteCode: 'abc',
    });
    expect(parsed.inviteCode).toBe('abc');
  });

  test('still requires a department for Internal Team', () => {
    expect(() => registerSchema.parse({ ...base, email: 'a@b.co', role: 'INTERNAL' })).toThrow();
  });
});
