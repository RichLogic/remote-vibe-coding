import Fastify from 'fastify';
import cors from '@fastify/cors';

import { buildBootstrapPayload } from './bootstrap.js';

const port = Number.parseInt(process.env.PORT ?? '8787', 10);
const host = process.env.HOST ?? '127.0.0.1';

const app = Fastify({
  logger: true
});

await app.register(cors, {
  origin: true
});

app.get('/api/health', async () => ({
  ok: true,
  service: 'remote-vibe-coding-host'
}));

app.get('/api/bootstrap', async () => buildBootstrapPayload());

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
