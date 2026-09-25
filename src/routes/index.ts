import { Hono } from 'hono';
import type { AppVariables } from '../types/hono';
import authRoutes from './auth.routes';
import projectRoutes from './project.routes';
import taskRoutes from './task.routes';
import userRoutes from './user.routes';

const routes = new Hono<{ Variables: AppVariables }>();

routes.route('/auth', authRoutes);
routes.route('/projects', projectRoutes);
routes.route('/tasks', taskRoutes);
routes.route('/users', userRoutes);

export default routes;
