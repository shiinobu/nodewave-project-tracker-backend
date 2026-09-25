import type { MiddlewareHandler } from 'hono';
import { ForbiddenError, UnauthorizedError } from '../lib/errors';
import { verifyToken } from '../lib/jwt';
import type { AppVariables } from '../types/hono';

export const authenticate: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing bearer token');
  }

  try {
    const payload = verifyToken(header.slice('Bearer '.length));
    c.set('user', payload);
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }

  await next();
};

export function requireRole(
  ...roles: Array<'PM' | 'INTERNAL' | 'CLIENT'>
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const user = c.get('user');
    if (!roles.includes(user.role)) {
      throw new ForbiddenError(`Requires role: ${roles.join(' or ')}`);
    }
    await next();
  };
}
