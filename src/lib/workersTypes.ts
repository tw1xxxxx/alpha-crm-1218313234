export type WorkerStatus = 'online' | 'idle' | 'offline' | 'warning';

export type StatsPeriod = 'today' | 'yesterday' | '3days' | 'week' | 'month';

export interface WorkerHw {
  cpu?: string;
  cores?: number;
  ram_gb?: number;
  gpu?: string;
  gpu_count?: number;
}

export interface WorkerLive {
  id: string;
  name: string;
  host?: string;
  hw?: WorkerHw;
  status: WorkerStatus;
  temperatureC: number;
  /** Мощность под нашей нагрузкой (power × util%) */
  powerUsW: number;
  /** Остальная мощность GPU */
  powerOthersW: number;
  powerTotalW?: number;
  hashrateMh?: number;
  utilPct?: number;
  running?: boolean;
  sharesFound?: number;
  sharesRejected?: number;
  lastSeenAt: string;
  uptimeSec?: number;
}

export interface StatsPoint {
  at: string;
  label: string;
  powerUsWh: number;
  powerOthersWh: number;
  avgTempC: number;
  avgHashrateMh?: number;
  avgUtilPct?: number;
  samples?: number;
}

export interface WorkerStats {
  workerId: string;
  period: StatsPeriod;
  granularity: 'hour' | 'day';
  points: StatsPoint[];
  totals: {
    powerUsWh: number;
    powerOthersWh: number;
    avgTempC: number;
    maxTempC: number;
    avgHashrateMh?: number;
  };
}

export const STATS_PERIODS: { id: StatsPeriod; label: string; granularity: 'hour' | 'day' }[] = [
  { id: 'today', label: 'Сегодня', granularity: 'hour' },
  { id: 'yesterday', label: 'Вчера', granularity: 'hour' },
  { id: '3days', label: '3 дня', granularity: 'day' },
  { id: 'week', label: 'Неделя', granularity: 'day' },
  { id: 'month', label: 'Месяц', granularity: 'day' },
];
