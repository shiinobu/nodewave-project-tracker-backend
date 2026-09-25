import { Hono } from 'hono';
import { z } from 'zod';
import {
  addAttachmentSchema,
  addCommentSchema,
  addDependencySchema,
  createTaskSchema,
  updateTaskSchema,
  updateTaskStatusSchema,
} from '../dto/task.dto';
import { ValidationError } from '../lib/errors';
import { readJson } from '../lib/http';
import { authenticate, requireRole } from '../middlewares/auth.middleware';
import * as taskService from '../services/task.service';
import type { AppVariables } from '../types/hono';

const tasks = new Hono<{ Variables: AppVariables }>();

tasks.use('*', authenticate);

tasks.get('/', async (c) => {
  const result = await taskService.listTasks(c.get('user'), c.req.query());
  return c.json(result);
});

tasks.get('/:id', async (c) => {
  const result = await taskService.getTask(c.get('user'), c.req.param('id'));
  return c.json(result);
});

// PM-only: create tasks and set their core fields.
tasks.post('/', requireRole('PM'), async (c) => {
  const input = createTaskSchema.parse(await readJson(c));
  const result = await taskService.createTask(c.get('user'), input);
  return c.json(result, 201);
});

// PM-only: title/description/assignee/client-visibility. Internal Team may not touch these.
tasks.patch('/:id', requireRole('PM'), async (c) => {
  const input = updateTaskSchema.parse(await readJson(c));
  const result = await taskService.updateTask(c.get('user'), c.req.param('id'), input);
  return c.json(result);
});

// PM and Internal Team both hit this; the service layer enforces the state-based rules
// (department/assignee match, dependency block, the PM can't-complete carve-out).
tasks.patch('/:id/status', requireRole('PM', 'INTERNAL'), async (c) => {
  const input = updateTaskStatusSchema.parse(await readJson(c));
  const result = await taskService.updateTaskStatus(c.get('user'), c.req.param('id'), input);
  return c.json(result);
});

// PM-only: declare "this task can't start before that one is Done".
tasks.post('/:id/dependencies', requireRole('PM'), async (c) => {
  const input = addDependencySchema.parse(await readJson(c));
  const result = await taskService.addDependency(c.get('user'), c.req.param('id'), input);
  return c.json(result, 201);
});

tasks.get('/:id/audit-logs', async (c) => {
  const result = await taskService.listAuditLogs(c.get('user'), c.req.param('id'), c.req.query());
  return c.json(result);
});

// PM and Internal Team (project members) can discuss a task; Client Guest cannot.
tasks.post('/:id/comments', requireRole('PM', 'INTERNAL'), async (c) => {
  const input = addCommentSchema.parse(await readJson(c));
  const result = await taskService.addComment(c.get('user'), c.req.param('id'), input);
  return c.json(result, 201);
});

// Link-based "upload": the Internal Team's explicit "upload work attachments" privilege.
tasks.post('/:id/attachments', requireRole('PM', 'INTERNAL'), async (c) => {
  const input = addAttachmentSchema.parse(await readJson(c));
  const result = await taskService.addAttachment(c.get('user'), c.req.param('id'), input);
  return c.json(result, 201);
});

// PM-only, optimistic-locked soft delete: ?version=<n> from the task the client last read.
tasks.delete('/:id', requireRole('PM'), async (c) => {
  const parsed = z.coerce.number().int().nonnegative().safeParse(c.req.query('version'));
  if (!parsed.success) {
    throw new ValidationError('A version query parameter is required');
  }
  await taskService.deleteTask(c.get('user'), c.req.param('id'), parsed.data);
  return c.body(null, 204);
});

export default tasks;
