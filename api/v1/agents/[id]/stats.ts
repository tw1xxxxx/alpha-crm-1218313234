import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  findAgentById,
  getTelemetryBuckets,
  type StatsPeriod,
} from '../../_lib/agentsDb';

const PERIODS: StatsPeriod[] = ['today', 'yesterday', '3days', 'week', 'month'];

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function labelFor(iso: string, granularity: 'hour' | 'day') {
  const d = new Date(iso);
  if (granularity === 'hour') return `${pad(d.getHours())}:00`;
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
}

/**
 * GET /api/v1/agents/:id/stats?period=today|yesterday|3days|week|month
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const idRaw = req.query.id;
    const agentId = Array.isArray(idRaw) ? idRaw[0] : idRaw;
    if (!agentId) {
      return res.status(400).json({ ok: false, error: 'id required' });
    }

    const periodRaw = Array.isArray(req.query.period) ? req.query.period[0] : req.query.period;
    const period = (periodRaw ?? 'today') as StatsPeriod;
    if (!PERIODS.includes(period)) {
      return res.status(400).json({ ok: false, error: `period must be one of ${PERIODS.join(', ')}` });
    }

    const agent = await findAgentById(agentId);
    if (!agent) {
      return res.status(404).json({ ok: false, error: 'Agent not found' });
    }

    const { granularity, buckets } = await getTelemetryBuckets(agentId, period);

    const points = buckets.map((b) => {
      const util = b.avg_util_pct;
      const power = b.avg_power_w;
      const powerUs = (power * util) / 100;
      const powerOthers = Math.max(0, power - powerUs);
      // Approximate Wh for the bucket: avg watts * hours in bucket
      const hours = granularity === 'hour' ? 1 : 24;
      return {
        at: b.bucket,
        label: labelFor(b.bucket, granularity),
        powerUsWh: Math.round(powerUs * hours),
        powerOthersWh: Math.round(powerOthers * hours),
        avgTempC: Math.round(b.avg_temp_c * 10) / 10,
        avgHashrateMh: Math.round(b.avg_hashrate_mh * 10) / 10,
        avgUtilPct: Math.round(b.avg_util_pct * 10) / 10,
        samples: b.samples,
      };
    });

    const powerUsWh = points.reduce((s, p) => s + p.powerUsWh, 0);
    const powerOthersWh = points.reduce((s, p) => s + p.powerOthersWh, 0);
    const avgTempC = points.length
      ? Math.round((points.reduce((s, p) => s + p.avgTempC, 0) / points.length) * 10) / 10
      : 0;
    const maxTempC = points.length ? Math.max(...points.map((p) => p.avgTempC)) : 0;
    const avgHashrateMh = points.length
      ? Math.round((points.reduce((s, p) => s + (p.avgHashrateMh ?? 0), 0) / points.length) * 10) / 10
      : 0;

    return res.status(200).json({
      ok: true,
      workerId: agentId,
      period,
      granularity,
      points,
      totals: {
        powerUsWh,
        powerOthersWh,
        avgTempC,
        maxTempC,
        avgHashrateMh,
      },
    });
  } catch (error) {
    console.error('[api/v1/agents/[id]/stats]', error);
    return res.status(500).json({ ok: false, error: 'Failed to load stats' });
  }
}
