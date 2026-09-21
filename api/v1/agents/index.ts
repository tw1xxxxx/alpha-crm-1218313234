import type { VercelRequest, VercelResponse } from '@vercel/node';
import { listAgents, type AgentStats } from '../_lib/agentsDb';

const ONLINE_MS = 90_000;

function deriveStatus(lastSeen: string | null, stats: AgentStats | null): 'online' | 'idle' | 'offline' | 'warning' {
  if (!lastSeen) return 'offline';
  const age = Date.now() - new Date(lastSeen).getTime();
  if (age > ONLINE_MS) return 'offline';
  if (stats?.gpu_temp_c != null && stats.gpu_temp_c >= 80) return 'warning';
  if (stats && !stats.running) return 'idle';
  return 'online';
}

/**
 * GET /api/v1/agents — dashboard list of registered agents + last stats
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const rows = await listAgents();
    const agents = rows.map((a) => {
      const stats = a.last_stats;
      const util = Number(stats?.gpu_util_pct ?? 0);
      const power = Number(stats?.gpu_power_w ?? 0);
      const powerUsW = Math.round((power * util) / 100);
      const powerOthersW = Math.max(0, Math.round(power - powerUsW));

      return {
        id: a.agent_id,
        name: a.hw?.gpu ? String(a.hw.gpu) : a.agent_id.slice(0, 8),
        host: a.hw?.cpu ? String(a.hw.cpu) : undefined,
        hw: a.hw,
        status: deriveStatus(a.last_seen, stats),
        temperatureC: Number(stats?.gpu_temp_c ?? 0),
        powerUsW,
        powerOthersW,
        powerTotalW: power,
        hashrateMh: Number(stats?.hashrate_mh ?? 0),
        utilPct: util,
        running: Boolean(stats?.running),
        sharesFound: Number(stats?.shares_found ?? 0),
        sharesRejected: Number(stats?.shares_rejected ?? 0),
        lastSeenAt: a.last_seen ?? a.created_at,
      };
    });

    return res.status(200).json({ ok: true, agents });
  } catch (error) {
    console.error('[api/v1/agents]', error);
    return res.status(500).json({ ok: false, error: 'Failed to list agents' });
  }
}
