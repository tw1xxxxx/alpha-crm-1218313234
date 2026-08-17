import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getStoreKey, setStoreKey } from '../_lib/db';
import { parseIncomingLeads } from '../_lib/parseIncomingLead';

const INCOMING_KEY = 'crm_incoming_leads_v1';

function webhookToken(): string {
  return process.env.CRM_LEAD_WEBHOOK_TOKEN || process.env.CRM_SYNC_SECRET || '';
}

function tokenFromReq(req: VercelRequest): string {
  const q = req.query.token;
  if (typeof q === 'string') return q;
  if (Array.isArray(q) && q[0]) return q[0];
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const header = req.headers['x-webhook-token'];
  if (typeof header === 'string') return header;
  return '';
}

function cors(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Webhook-Token');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const expected = webhookToken();
  if (!expected) {
    return res.status(503).json({
      ok: false,
      error: 'Webhook token is not configured (CRM_LEAD_WEBHOOK_TOKEN or CRM_SYNC_SECRET)',
    });
  }
  if (tokenFromReq(req) !== expected) {
    return res.status(401).json({ ok: false, error: 'Invalid token' });
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      message: 'Lead webhook is ready. Send POST from dmp.one with JSON body.',
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!process.env.POSTGRES_URL) {
    return res.status(503).json({
      ok: false,
      error: 'POSTGRES_URL is not set. Incoming leads cannot be stored.',
    });
  }

  try {
    const parsed = parseIncomingLeads(req.body);
    if (parsed.length === 0) {
      return res.status(400).json({ ok: false, error: 'No lead fields found (need phone or name)' });
    }

    const existing = await getStoreKey(INCOMING_KEY);
    const next = [...parsed, ...(Array.isArray(existing) ? existing : [])];
    await setStoreKey(INCOMING_KEY, next);

    return res.status(200).json({ ok: true, accepted: parsed.length });
  } catch (error) {
    console.error('[api/leads/incoming]', error);
    return res.status(500).json({ ok: false, error: 'Failed to save lead' });
  }
}
