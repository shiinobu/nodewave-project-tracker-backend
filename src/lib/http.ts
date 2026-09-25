import type { Context } from 'hono';
import { ValidationError } from './errors';

/**
 * Reads the request body as JSON. `c.req.json()` throws a bare SyntaxError on an empty or
 * malformed body, which the error handler can only report as a 500 — but that is the
 * caller's mistake, so it is reported as one.
 */
export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }
}
