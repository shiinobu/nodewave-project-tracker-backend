import { Hono } from 'hono';
import { loginSchema, registerSchema } from '../dto/auth.dto';
import { readJson } from '../lib/http';
import { authenticate } from '../middlewares/auth.middleware';
import * as authService from '../services/auth.service';
import type { AppVariables } from '../types/hono';

const auth = new Hono<{ Variables: AppVariables }>();

auth.post('/register', async (c) => {
  const input = registerSchema.parse(await readJson(c));
  const result = await authService.register(input);
  return c.json(result, 201);
});

auth.post('/login', async (c) => {
  const input = loginSchema.parse(await readJson(c));
  const result = await authService.login(input);
  return c.json(result);
});

// Stateless JWT: nothing to invalidate server-side. Exists so the frontend has a
// single, guarded place to route the "sign out" action through.
auth.post('/logout', authenticate, async (c) => {
  return c.json({ message: 'Logged out' });
});

auth.get('/me', authenticate, async (c) => {
  const me = await authService.getMe(c.get('user').sub);
  return c.json(me);
});

export default auth;
