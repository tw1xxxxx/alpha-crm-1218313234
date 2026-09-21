import { mockWorkerStats, mockWorkersLive } from './workersMock';
import type { StatsPeriod, WorkerLive, WorkerStats } from './workersTypes';

/**
 * Base URL for workers backend.
 * When ready, set VITE_WORKERS_API_URL (e.g. https://api.example.com)
 * and implement the real shapes in fetchWorkers / fetchWorkerStats.
 */
const API_BASE = (import.meta.env.VITE_WORKERS_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

const USE_MOCK = !API_BASE;

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
  // Expected: GET /workers → WorkerLive[]
  return getJson<WorkerLive[]>('/workers');
}

/** Stats for one worker and period */
export async function fetchWorkerStats(workerId: string, period: StatsPeriod): Promise<WorkerStats> {
  if (USE_MOCK) {
    await delay(220);
    return mockWorkerStats(workerId, period);
  }
  // Expected: GET /workers/:id/stats?period=today|yesterday|3days|week|month
  return getJson<WorkerStats>(`/workers/${encodeURIComponent(workerId)}/stats?period=${period}`);
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function isWorkersMockMode() {
  return USE_MOCK;
}
