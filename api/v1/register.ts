import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkBootstrapToken, readJsonBody } from '../_lib/agentAuth';
import { upsertAgentRegister, type AgentHw } from '../_lib/agentsDb';

type RegisterBody = {
  type?: string;
  agent_id?: string;
  hw?: AgentHw;
};

/**
 * POST /api/v1/register
 * Body: { type: "register", agent_id, hw: {...} }
 * Auth: X-Agent-Bootstrap-Token (or CRM_SYNC_SECRET)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!checkBootstrapToken(req, res)) return;

  try {
    const body = readJsonBody<RegisterBody>(req);
    if (!body?.agent_id || typeof body.agent_id !== 'string') {
      return res.status(400).json({ ok: false, error: 'agent_id is required' });
    }
    if (body.type && body.type !== 'register') {
      return res.status(400).json({ ok: false, error: 'type must be register' });
    }

    const { token, config, created } = await upsertAgentRegister(body.agent_id, body.hw ?? {});

    return res.status(created ? 201 : 200).json({
      ok: true,
      created,
      agent_id: body.agent_id,
      token,
      config: {
        type: 'config',
        pool: config.pool,
        throttle: config.throttle,
        heartbeat_sec: config.heartbeat_sec,
      },
    });
  } catch (error) {
    console.error('[api/v1/register]', error);
    return res.status(500).json({ ok: false, error: 'Register failed' });
  }
}
