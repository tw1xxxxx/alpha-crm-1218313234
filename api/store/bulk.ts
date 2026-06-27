import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkAuth } from '../_lib/auth';
import { getAllStore, setBulkStore } from '../_lib/db';
import { isAllowedStoreKey } from '../_lib/keys';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!checkAuth(req, res)) return;

  try {
    if (req.method === 'GET') {
      const data = await getAllStore();
      return res.status(200).json({ data });
    }

    if (req.method === 'PUT') {
      const body = req.body as { data?: Record<string, unknown> } | undefined;
      if (!body?.data || typeof body.data !== 'object') {
        return res.status(400).json({ error: 'Body must be { data: { key: array } }' });
      }

      const sanitized: Record<string, unknown[]> = {};
      for (const [key, val] of Object.entries(body.data)) {
        if (!isAllowedStoreKey(key) || !Array.isArray(val)) continue;
        sanitized[key] = val;
      }

      await setBulkStore(sanitized);
      return res.status(200).json({ ok: true, keys: Object.keys(sanitized) });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[api/store/bulk]', error);
    return res.status(500).json({ error: 'Database error' });
  }
}
