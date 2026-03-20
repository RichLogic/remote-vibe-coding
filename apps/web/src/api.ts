import type { BootstrapPayload } from './types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8787';

export async function fetchBootstrap(): Promise<BootstrapPayload> {
  const response = await fetch(`${API_BASE_URL}/api/bootstrap`);
  if (!response.ok) {
    throw new Error(`Bootstrap request failed with status ${response.status}`);
  }

  return response.json() as Promise<BootstrapPayload>;
}
