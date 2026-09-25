import server from './index';

// Vercel looks for a Bun.serve() call at module load and routes every request to it. Local
// runs (`bun run dev`, `bun run start`) keep using the default export of index.ts.
Bun.serve({ fetch: server.fetch });
