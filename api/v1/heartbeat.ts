import type { VercelRequest, VercelResponse } from '@vercel/node';
import { findAgentById, findAgentByToken, recordHeartbeat, type AgentStats } from '../_lib/agentsDb';
import { getAgentTokenHeader, readJsonBody } from '../_lib/agentAuth';

type HeartbeatBody = {
  type?: string;
  agent_id?: string;
  stats?: Partial<AgentStats>;
};

function normalizeStats(raw: Partial<AgentStats> | undefined): AgentStats | null {
  if (!raw || typeof raw !== 'object') return null;
  return {
    hashrate_mh: Number(raw.hashrate_mh ?? 0),
    gpu_temp_c: Number(raw.gpu_temp_c ?? 0),
    gpu_power_w: Number(raw.gpu_power_w ?? 0),
    gpu_util_pct: Number(raw.gpu_util_pct ?? 0),
    running: Boolean(raw.running),
    shares_found: Number(raw.shares_found ?? 0),
    shares_rejected: Number(raw.shares_rejected ?? 0),
  };
}

/**
 * POST /api/v1/heartbeat
 * Body: { type: "heartbeat", agent_id, stats: {...} }
 * Auth: X-Agent-Token (issued at register)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const token = getAgentTokenHeader(req);
    if (!token) {
      return res.status(401).json({ ok: false, error: 'X-Agent-Token required' });
    }

    const byToken = await findAgentByToken(token);
    if (!byToken) {
      return res.status(401).json({ ok: false, error: 'Invalid agent token' });
    }

    const body = readJsonBody<HeartbeatBody>(req);
    if (!body?.agent_id) {
      return res.status(400).json({ ok: false, error: 'agent_id is required' });
    }
    if (body.agent_id !== byToken.agent_id) {
      return res.status(403).json({ ok: false, error: 'agent_id does not match token' });
    }
    if (body.type && body.type !== 'heartbeat') {
      return res.status(400).json({ ok: false, error: 'type must be heartbeat' });
    }

    const stats = normalizeStats(body.stats);
    if (!stats) {
      return res.status(400).json({ ok: false, error: 'stats is required' });
    }

    const agent = await findAgentById(body.agent_id);
    if (!agent) {
      return res.status(404).json({ ok: false, error: 'Agent not found' });
    }

    const { command } = await recordHeartbeat(body.agent_id, stats);

    return res.status(200).json({
      ok: true,
      command: command?.cmd ?? null,
      params: command?.params ?? {},
      config: {
        type: 'config',
        pool: agent.config?.pool,
        throttle: agent.config?.throttle,
        heartbeat_sec: agent.config?.heartbeat_sec ?? 30,
      },
    });
  } catch (error) {
    console.error('[api/v1/heartbeat]', error);
    return res.status(500).json({ ok: false, error: 'Heartbeat failed' });
  }
}
