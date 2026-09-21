export type WorkerStatus = 'online' | 'idle' | 'offline' | 'warning';

export type StatsPeriod = 'today' | 'yesterday' | '3days' | 'week' | 'month';

export interface WorkerLive {
  id: string;
  name: string;
  host?: string;
  status: WorkerStatus;
  temperatureC: number;
  powerUsW: number;
  powerOthersW: number;
  lastSeenAt: string;
  uptimeSec?: number;
}

export interface StatsPoint {
  /** ISO timestamp for the bucket start */
  at: string;
  /** Label for chart axis (hour or day) */
  label: string;
  powerUsWh: number;
  powerOthersWh: number;
  avgTempC: number;
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
  };
}

export const STATS_PERIODS: { id: StatsPeriod; label: string; granularity: 'hour' | 'day' }[] = [
  { id: 'today', label: 'Сегодня', granularity: 'hour' },
  { id: 'yesterday', label: 'Вчера', granularity: 'hour' },
  { id: '3days', label: '3 дня', granularity: 'day' },
  { id: 'week', label: 'Неделя', granularity: 'day' },
  { id: 'month', label: 'Месяц', granularity: 'day' },
];
