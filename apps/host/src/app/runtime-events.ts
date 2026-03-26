import type { FastifyBaseLogger } from 'fastify';

import type { AgentRuntimeEventSource, AgentRuntimeNotification, AgentRuntimeServerRequest } from './agent-runtime.js';

interface BindRuntimeEventsOptions {
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  runtime: AgentRuntimeEventSource;
  handleNotification: (message: AgentRuntimeNotification) => Promise<unknown>;
  handleServerRequest: (message: AgentRuntimeServerRequest) => Promise<unknown>;
  markAllStale: () => Promise<unknown>;
}

export function bindRuntimeEvents(options: BindRuntimeEventsOptions) {
  options.runtime.on('debug', (message) => {
    options.log.info(message);
  });

  options.runtime.on('notification', (message) => {
    void options.handleNotification(message);
  });

  options.runtime.on('serverRequest', (message) => {
    void options.handleServerRequest(message);
  });

  options.runtime.on('runtimeStopped', (message) => {
    options.log.warn(message);
    void options.markAllStale();
  });
}
