import type { VercelRequest, VercelResponse } from '@vercel/node';

/** Bootstrap token for first register (env AGENT_BOOTSTRAP_TOKEN or CRM_SYNC_SECRET). */
export function checkBootstrapToken(req: VercelRequest, res: VercelResponse): boolean {
  const expected = process.env.AGENT_BOOTSTRAP_TOKEN || process.env.CRM_SYNC_SECRET;
  if (!expected) {
    res.status(503).json({
      ok: false,
      error: 'AGENT_BOOTSTRAP_TOKEN or CRM_SYNC_SECRET is not configured',
    });
    return false;
  }

  const header =
    (req.headers['x-agent-bootstrap-token'] as string | undefined) ||
    (req.headers['x-agent-token'] as string | undefined) ||
    '';

  const auth = req.headers.authorization;
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : '';

  if (header !== expected && bearer !== expected) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

export function getAgentTokenHeader(req: VercelRequest): string | null {
  const header = req.headers['x-agent-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

export function readJsonBody<T>(req: VercelRequest): T | null {
  if (!req.body) return null;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body) as T;
    } catch {
      return null;
    }
  }
  return req.body as T;
}
