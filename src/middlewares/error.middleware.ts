import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import { Prisma } from '../../generated/prisma/client';
import { HttpError } from '../lib/errors';

/**
 * Database errors that are the caller's doing rather than ours. Messages are fixed strings:
 * Prisma's own text names tables, constraints and query internals.
 */
function fromPrisma(err: unknown): HttpError | null {
  if (err instanceof Prisma.PrismaClientValidationError) {
    return new HttpError(422, 'Invalid input');
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002')
      return new HttpError(409, 'A record with these values already exists');
    if (err.code === 'P2003') return new HttpError(422, 'A referenced record does not exist');
    if (err.code === 'P2025') return new HttpError(404, 'Record not found');
  }
  return null;
}

export const errorHandler: ErrorHandler = (err, c) => {
  const known = err instanceof HttpError ? err : fromPrisma(err);
  if (known) {
    return c.json(
      { error: known.message, details: known.details },
      known.status as ContentfulStatusCode,
    );
  }

  if (err instanceof ZodError) {
    return c.json({ error: 'Validation failed', details: err.flatten() }, 422);
  }

  console.error(err);
  return c.json({ error: 'Internal server error' }, 500);
};
