import { Hono } from 'hono';
import { authenticate } from '../middlewares/auth.middleware';
import * as userService from '../services/user.service';
import type { AppVariables } from '../types/hono';

const users = new Hono<{ Variables: AppVariables }>();

users.use('*', authenticate);

users.get('/', async (c) => {
  const result = await userService.listUsers(c.get('user'), c.req.query());
  return c.json(result);
});

export default users;
