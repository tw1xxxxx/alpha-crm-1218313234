import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkAuth } from '../_lib/auth';
import { getStoreKey, setStoreKey } from '../_lib/db';
import { isAllowedStoreKey } from '../_lib/keys';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const key = req.query.key as string | undefined;
  if (!key || !isAllowedStoreKey(key)) {
    return res.status(400).json({ error: 'Invalid or missing store key' });
  }

  if (!checkAuth(req, res)) return;

  try {
    if (req.method === 'GET') {
      const data = await getStoreKey(key);
      return res.status(200).json({ key, data });
    }

    if (req.method === 'PUT') {
      const body = req.body;
      if (!Array.isArray(body)) {
        return res.status(400).json({ error: 'Request body must be a JSON array' });
      }
      await setStoreKey(key, body);
      return res.status(200).json({ ok: true, key });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[api/store]', key, error);
    return res.status(500).json({ error: 'Database error' });
  }
}
