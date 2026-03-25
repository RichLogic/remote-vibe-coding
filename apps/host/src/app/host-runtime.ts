import { ChatHistoryRepository } from '../chat-history.js';
import { CloudflareTunnelManager } from '../cloudflare.js';
import { CodexAppServerClient } from '../codex-app-server.js';
import { CodingRepository } from '../coding/repository.js';
import { getMongoDb } from '../mongo.js';
import { SessionStore } from '../store.js';
import { HostAuthState } from './auth-state.js';
import { CloudflareStatusCache } from './cloudflare-status-cache.js';
import { ModelCatalog } from './model-catalog.js';

export interface HostRuntime {
  auth: HostAuthState;
  store: SessionStore;
  chatHistory: ChatHistoryRepository;
  coding: CodingRepository;
  codex: CodexAppServerClient;
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
  const coding = new CodingRepository(mongoDb);
  await chatHistory.ensureIndexes();
  await coding.ensureIndexes();

  const seedUsers = auth.listUsers();
  await Promise.all(seedUsers.map((user) => options.syncUserWorkspaceRecords(user.username, user.id, {
    store,
    coding,
  })));
  await options.loadChatSystemPromptText();
  await options.loadChatRolePresetConfig();

  const codex = new CodexAppServerClient();
  await codex.ensureStarted();
  await store.markAllStale(options.staleSessionMessage);
  await chatHistory.markAllStale(options.staleSessionMessage);
  await coding.markAllStale(options.staleSessionMessage);

  const cloudflare = new CloudflareTunnelManager();
  const cloudflareStatusCache = new CloudflareStatusCache(cloudflare);
  void cloudflareStatusCache.refresh().catch(() => undefined);

  const modelCatalog = new ModelCatalog(codex);
  await modelCatalog.refresh();

  return {
    auth,
    store,
    chatHistory,
    coding,
    codex,
    cloudflare,
    cloudflareStatusCache,
    modelCatalog,
    async shutdown() {
      await cloudflare.disconnect();
      await codex.stop();
    },
  };
}
