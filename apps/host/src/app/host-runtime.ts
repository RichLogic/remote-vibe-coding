import { ChatHistoryRepository } from '../chat-history.js';
import { CloudflareTunnelManager } from '../cloudflare.js';
import { CodingHistoryRepository } from '../coding/history.js';
import { CodingRepository } from '../coding/repository.js';
import { ClaudeCodeCliRuntime, claudeCodeExecutableAvailable } from '../claude-code-runtime.js';
import {
  EXECUTOR_INIT_ENV_VAR,
  defaultExecutorForConfiguredExecutors,
  resolveConfiguredExecutors,
} from '../executor.js';
import { getMongoDb } from '../mongo.js';
import { SessionStore } from '../store.js';
import { CodexAppServerClient } from '../codex-app-server.js';
import { StaticAgentRuntimeRegistry, type AgentRuntimeRegistry } from './agent-runtime.js';
import { HostAuthState } from './auth-state.js';
import { CloudflareStatusCache } from './cloudflare-status-cache.js';
import { ModelCatalog } from './model-catalog.js';

export interface HostRuntime {
  auth: HostAuthState;
  store: SessionStore;
  chatHistory: ChatHistoryRepository;
  codingHistory: CodingHistoryRepository;
  coding: CodingRepository;
  runtimeRegistry: AgentRuntimeRegistry;
  cloudflare: CloudflareTunnelManager;
  cloudflareStatusCache: CloudflareStatusCache;
  modelCatalog: ModelCatalog;
  shutdown: () => Promise<void>;
}

interface InitializeHostRuntimeOptions {
  staleSessionMessage: string;
  syncUserWorkspaceRecords: (
    username: string,
    userId: string,
    dependencies: {
      store: SessionStore;
      coding: CodingRepository;
    },
  ) => Promise<unknown>;
  loadChatSystemPromptText: () => Promise<unknown>;
  loadChatRolePresetConfig: () => Promise<unknown>;
}

export async function initializeHostRuntime(options: InitializeHostRuntimeOptions): Promise<HostRuntime> {
  const auth = await HostAuthState.load();
  const fallbackOwner = auth.fallbackOwner();

  const store = new SessionStore();
  await store.load({
    fallbackOwnerUserId: fallbackOwner.id,
    fallbackOwnerUsername: fallbackOwner.username,
  });

  const mongoDb = await getMongoDb();
  const chatHistory = new ChatHistoryRepository(mongoDb);
  const codingHistory = new CodingHistoryRepository(mongoDb);
  const coding = new CodingRepository(mongoDb);
  await chatHistory.ensureIndexes();
  await codingHistory.ensureIndexes();
  await coding.ensureIndexes();

  const seedUsers = auth.listUsers();
  await Promise.all(seedUsers.map((user) => options.syncUserWorkspaceRecords(user.username, user.id, {
    store,
    coding,
  })));
  await options.loadChatSystemPromptText();
  await options.loadChatRolePresetConfig();

  const claudeAvailable = claudeCodeExecutableAvailable();
  const requestedExecutors = resolveConfiguredExecutors({ claudeAvailable });
  const requestedExecutorSet = new Set(requestedExecutors);

  if (requestedExecutorSet.has('claude-code') && !claudeAvailable) {
    throw new Error(
      `${EXECUTOR_INIT_ENV_VAR} requested claude-code, but the Claude Code executable is not available. Set CLAUDE_BIN or choose codex.`,
    );
  }

  const agentRuntime = requestedExecutorSet.has('codex')
    ? new CodexAppServerClient()
    : null;
  if (agentRuntime) {
    await agentRuntime.ensureStarted();
  }

  const claudeRuntime = requestedExecutorSet.has('claude-code')
    ? new ClaudeCodeCliRuntime()
    : null;
  if (claudeRuntime) {
    await claudeRuntime.ensureStarted();
  }
  if (!agentRuntime && !claudeRuntime) {
    throw new Error('No agent runtimes are configured.');
  }
  await store.markAllStale(options.staleSessionMessage);
  await chatHistory.markAllStale(options.staleSessionMessage);
  await coding.markAllStale(options.staleSessionMessage);

  const cloudflare = new CloudflareTunnelManager();
  const cloudflareStatusCache = new CloudflareStatusCache(cloudflare);
  void cloudflareStatusCache.refresh().catch(() => undefined);

  const runtimeRegistry = new StaticAgentRuntimeRegistry({
    ...(agentRuntime ? { codex: agentRuntime } : {}),
    ...(claudeRuntime ? { 'claude-code': claudeRuntime } : {}),
  }, defaultExecutorForConfiguredExecutors(requestedExecutors));
  const modelCatalog = new ModelCatalog(runtimeRegistry);
  await modelCatalog.refresh();

  return {
    auth,
    store,
    chatHistory,
    codingHistory,
    coding,
    runtimeRegistry,
    cloudflare,
    cloudflareStatusCache,
    modelCatalog,
    async shutdown() {
      await cloudflare.disconnect();
      if (claudeRuntime) {
        await claudeRuntime.stop();
      }
      if (agentRuntime) {
        await agentRuntime.stop();
      }
    },
  };
}
