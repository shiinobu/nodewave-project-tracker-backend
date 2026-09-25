import { Hono } from 'hono';
import { addMemberSchema, createProjectSchema, updateProjectSchema } from '../dto/project.dto';
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

projects.patch('/:id', requireRole('PM'), async (c) => {
  const input = updateProjectSchema.parse(await readJson(c));
  const result = await projectService.updateProject(c.req.param('id'), input);
  return c.json(result);
});

projects.delete('/:id', requireRole('PM'), async (c) => {
  await projectService.deleteProject(c.req.param('id'));
  return c.body(null, 204);
});

// PM-only: who can see the project. Internal Team and Client Guest accounts only.
projects.post('/:id/members', requireRole('PM'), async (c) => {
  const input = addMemberSchema.parse(await readJson(c));
  const result = await projectService.addProjectMember(c.req.param('id'), input.userId);
  return c.json(result, 201);
});

projects.delete('/:id/members/:userId', requireRole('PM'), async (c) => {
  await projectService.removeProjectMember(c.req.param('id'), c.req.param('userId'));
  return c.body(null, 204);
});

export default projects;
