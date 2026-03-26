import { stat } from 'node:fs/promises';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

interface RegisterWebClientServingOptions {
  webDistDir: string;
}

export async function registerWebClientServing(
  app: FastifyInstance,
  options: RegisterWebClientServingOptions,
) {
  const hasBuiltWeb = await stat(options.webDistDir)
    .then((info) => info.isDirectory())
    .catch(() => false);

  if (hasBuiltWeb) {
    await app.register(fastifyStatic, {
      root: options.webDistDir,
      prefix: '/',
      setHeaders: (response, pathName) => {
        if (pathName.endsWith('.html')) {
          response.setHeader('Cache-Control', 'no-store');
        }
      },
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404);
      return { error: 'Not found' };
    }

    if (hasBuiltWeb) {
      reply.header('Cache-Control', 'no-store');
      return reply.sendFile('index.html');
    }

    reply.code(404);
    return {
      error: 'Web client is not built yet. Run `npm run build` or use `npm run dev:web` for local development.',
    };
  });
}
