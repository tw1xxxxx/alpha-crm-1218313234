import type { StatsPeriod, StatsPoint, WorkerLive, WorkerStats } from './workersTypes';

const NAMES = [
  { id: 'wrk-alpha-01', name: 'Alpha-01', host: 'DESKTOP-A1' },
  { id: 'wrk-alpha-02', name: 'Alpha-02', host: 'DESKTOP-B7' },
  { id: 'wrk-beta-03', name: 'Beta-03', host: 'MINING-RIG-3' },
  { id: 'wrk-gamma-04', name: 'Gamma-04', host: 'WS-GAMMA' },
  { id: 'wrk-delta-05', name: 'Delta-05', host: 'NODE-DELTA' },
  { id: 'wrk-epsilon-06', name: 'Epsilon-06', host: 'LAB-PC-06' },
];

function seeded(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function formatHourLabel(d: Date) {
  return `${pad(d.getHours())}:00`;
}

function formatDayLabel(d: Date) {
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
}

export function mockWorkersLive(): WorkerLive[] {
  const now = Date.now();
  return NAMES.map((w, i) => {
    const rnd = seeded(i * 97 + Math.floor(now / 60_000));
    const temp = 48 + rnd() * 38;
    const powerUs = 80 + rnd() * 220;
    const powerOthers = 20 + rnd() * 140;
    const statuses: WorkerLive['status'][] = ['online', 'online', 'idle', 'online', 'warning', 'offline'];
    const status = statuses[i % statuses.length];
    return {
      ...w,
      status,
      temperatureC: Math.round(temp * 10) / 10,
      powerUsW: Math.round(powerUs),
      powerOthersW: status === 'offline' ? 0 : Math.round(powerOthers),
      lastSeenAt: new Date(now - (status === 'offline' ? 3_600_000 : rnd() * 40_000)).toISOString(),
      uptimeSec: status === 'offline' ? 0 : Math.floor(20_000 + rnd() * 400_000),
    };
  });
}

function periodConfig(period: StatsPeriod): { buckets: number; granularity: 'hour' | 'day'; start: Date } {
  const now = new Date();
  if (period === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { buckets: now.getHours() + 1, granularity: 'hour', start };
  }
  if (period === 'yesterday') {
    const start = new Date(now);
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    return { buckets: 24, granularity: 'hour', start };
  }
  if (period === '3days') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 2);
    return { buckets: 3, granularity: 'day', start };
  }
  if (period === 'week') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
    return { buckets: 7, granularity: 'day', start };
  }
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 29);
  return { buckets: 30, granularity: 'day', start };
}

export function mockWorkerStats(workerId: string, period: StatsPeriod): WorkerStats {
  const { buckets, granularity, start } = periodConfig(period);
  const seedBase = workerId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rnd = seeded(seedBase + period.length * 13);

  const points: StatsPoint[] = [];
  for (let i = 0; i < buckets; i++) {
    const at = new Date(start);
    if (granularity === 'hour') at.setHours(start.getHours() + i);
    else at.setDate(start.getDate() + i);

    const us = 40 + rnd() * (granularity === 'hour' ? 180 : 2200);
    const others = 15 + rnd() * (granularity === 'hour' ? 120 : 1400);
    const temp = 55 + rnd() * 25;

    points.push({
      at: at.toISOString(),
      label: granularity === 'hour' ? formatHourLabel(at) : formatDayLabel(at),
      powerUsWh: Math.round(us),
      powerOthersWh: Math.round(others),
      avgTempC: Math.round(temp * 10) / 10,
    });
  }

  const powerUsWh = points.reduce((s, p) => s + p.powerUsWh, 0);
  const powerOthersWh = points.reduce((s, p) => s + p.powerOthersWh, 0);
  const avgTempC = points.length
    ? Math.round((points.reduce((s, p) => s + p.avgTempC, 0) / points.length) * 10) / 10
    : 0;
  const maxTempC = points.length ? Math.max(...points.map((p) => p.avgTempC)) : 0;

  return {
    workerId,
    period,
    granularity,
    points,
    totals: { powerUsWh, powerOthersWh, avgTempC, maxTempC },
  };
}
