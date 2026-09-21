import { mockWorkerStats, mockWorkersLive } from './workersMock';
import type { StatsPeriod, WorkerLive, WorkerStats } from './workersTypes';

/**
 * Base URL for workers API.
 * Default: same-origin `/api/v1` (Vercel serverless).
 * Override: VITE_WORKERS_API_URL=https://...
 * Force demo: VITE_WORKERS_USE_MOCK=1
 */
const ENV_BASE = (import.meta.env.VITE_WORKERS_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const USE_MOCK = import.meta.env.VITE_WORKERS_USE_MOCK === '1';
const API_BASE = ENV_BASE || '';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Workers API ${res.status}: ${path}`);
  }
  return res.json() as Promise<T>;
}

/** List of workers with live telemetry */
export async function fetchWorkers(): Promise<WorkerLive[]> {
  if (USE_MOCK) {
    await delay(180);
    return mockWorkersLive();
  }
  const data = await getJson<{ ok: boolean; agents: WorkerLive[] }>('/api/v1/agents');
  return data.agents ?? [];
}

/** Stats for one worker and period */
export async function fetchWorkerStats(workerId: string, period: StatsPeriod): Promise<WorkerStats> {
  if (USE_MOCK) {
    await delay(220);
    return mockWorkerStats(workerId, period);
  }
  const data = await getJson<WorkerStats & { ok: boolean }>(
    `/api/v1/agents/${encodeURIComponent(workerId)}/stats?period=${period}`,
  );
  return data;
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function isWorkersMockMode() {
  return USE_MOCK;
}
