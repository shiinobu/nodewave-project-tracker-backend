import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { errorHandler } from './middlewares/error.middleware';
import routes from './routes';
import type { AppVariables } from './types/hono';

const app = new Hono<{ Variables: AppVariables }>();

app.use('*', logger());
app.use(
  '*',
  cors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  }),
);

app.get('/', (c) => c.json({ status: 'ok', service: 'nodewave-project-tracker-backend' }));
app.get('/health', (c) => c.json({ status: 'ok' }));
app.route('/api', routes);

app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError(errorHandler);

const port = Number(process.env.PORT ?? 8000);
console.log(`Backend listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
