import { createHash, timingSafeEqual } from 'node:crypto';
import type { LoginInput, RegisterInput } from '../dto/auth.dto';
import { ForbiddenError, UnauthorizedError, ValidationError } from '../lib/errors';
import { signToken } from '../lib/jwt';
import { hashPassword, verifyPassword } from '../lib/password';
import { prisma } from '../lib/prisma';

function toPublicUser(user: {
  id: string;
  email: string;
  name: string;
  role: string;
  department: string | null;
  avatarUrl: string | null;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    department: user.department,
    avatarUrl: user.avatarUrl,
  };
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Sign-up is public, so the role a caller asks for cannot be trusted. Internal Team and
 * Client Guest are safe to self-assign: they see nothing until a PM adds them to a project.
 * A PM sees every project and client, so that role needs the server's PM_SIGNUP_CODE —
 * and when none is configured nobody can self-register as one (fails closed). The seeded
 * PM account covers normal use.
 */
function assertMayRegisterAs(role: RegisterInput['role'], inviteCode: string | undefined) {
  if (role !== 'PM') return;

  const expected = process.env.PM_SIGNUP_CODE;
  // Hashing first makes the comparison constant-time regardless of the code's length.
  if (!expected || !inviteCode || !timingSafeEqual(digest(inviteCode), digest(expected))) {
    throw new ForbiddenError('A valid invite code is required to register as a PM');
  }
}

export async function register(input: RegisterInput) {
  assertMayRegisterAs(input.role, input.inviteCode);

  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new ValidationError('An account with this email already exists');
  }

  const user = await prisma.user.create({
    data: {
      email: input.email,
      password: await hashPassword(input.password),
      name: input.name,
      role: input.role,
      department: input.role === 'INTERNAL' ? input.department : null,
    },
  });

  const token = signToken({
    sub: user.id,
    email: user.email,
    role: user.role,
    department: user.department,
  });
  return { token, user: toPublicUser(user) };
}

export async function login(input: LoginInput) {
  const user = await prisma.user.findFirst({ where: { email: input.email, deletedAt: null } });
  if (!user || !(await verifyPassword(input.password, user.password))) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const token = signToken({
    sub: user.id,
    email: user.email,
    role: user.role,
    department: user.department,
  });
  return { token, user: toPublicUser(user) };
}

export async function getMe(userId: string) {
  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
  if (!user) throw new UnauthorizedError('User not found');
  return toPublicUser(user);
}
