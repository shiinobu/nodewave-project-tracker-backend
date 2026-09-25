import { Hono } from 'hono';
import { createProjectSchema } from '../dto/project.dto';
import { readJson } from '../lib/http';
import { authenticate, requireRole } from '../middlewares/auth.middleware';
import * as projectService from '../services/project.service';
import type { AppVariables } from '../types/hono';

const projects = new Hono<{ Variables: AppVariables }>();

projects.use('*', authenticate);

projects.get('/', async (c) => {
  const result = await projectService.listProjects(c.get('user'), c.req.query());
  return c.json(result);
});

projects.get('/:id', async (c) => {
  const result = await projectService.getProject(c.get('user'), c.req.param('id'));
  return c.json(result);
});

projects.post('/', requireRole('PM'), async (c) => {
  const input = createProjectSchema.parse(await readJson(c));
  const result = await projectService.createProject(c.get('user'), input);
  return c.json(result, 201);
});

projects.delete('/:id', requireRole('PM'), async (c) => {
  await projectService.deleteProject(c.req.param('id'));
  return c.body(null, 204);
});

export default projects;
