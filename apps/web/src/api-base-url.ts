const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function normalizeApiBaseUrl(value: string | undefined) {
  return (value ?? '').trim().replace(/\/$/, '');
}

function isLoopbackHostname(hostname: string) {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

export function resolveApiBaseUrl() {
  const configured = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);

  if (!configured || typeof window === 'undefined') {
    return configured;
  }

  try {
    const url = new URL(configured, window.location.origin);
    if (isLoopbackHostname(url.hostname) && !isLoopbackHostname(window.location.hostname)) {
      return '';
    }
  } catch {
    return configured;
  }

  return configured;
}
