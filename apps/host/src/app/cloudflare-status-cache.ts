import type { CloudflareTunnelManager } from '../cloudflare.js';

const CLOUDFLARE_STATUS_CACHE_TTL_MS = 5000;

export class CloudflareStatusCache {
  private cachedStatus: Awaited<ReturnType<CloudflareTunnelManager['getStatus']>> | null = null;
  private cachedStatusExpiresAt = 0;
  private request: Promise<Awaited<ReturnType<CloudflareTunnelManager['getStatus']>>> | null = null;

  constructor(private readonly cloudflare: CloudflareTunnelManager) {}

  prime(status: Awaited<ReturnType<CloudflareTunnelManager['getStatus']>>) {
    this.cachedStatus = status;
    this.cachedStatusExpiresAt = Date.now() + CLOUDFLARE_STATUS_CACHE_TTL_MS;
  }

  clear() {
    this.cachedStatus = null;
    this.cachedStatusExpiresAt = 0;
    this.request = null;
  }

  async refresh() {
    if (this.request) {
      return this.request;
    }

    this.request = this.cloudflare.getStatus()
      .then((status) => {
        this.prime(status);
        return status;
      })
      .finally(() => {
        this.request = null;
      });

    return this.request;
  }

  async get(options?: { preferFresh?: boolean }) {
    if (this.cachedStatus && Date.now() < this.cachedStatusExpiresAt) {
      return this.cachedStatus;
    }

    if (!this.cachedStatus) {
      return this.refresh();
    }

    const refreshRequest = this.refresh();
    if (options?.preferFresh) {
      return refreshRequest;
    }

    void refreshRequest.catch(() => undefined);
    return this.cachedStatus;
  }
}
