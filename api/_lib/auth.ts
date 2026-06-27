import type { VercelRequest, VercelResponse } from '@vercel/node';

export function checkAuth(req: VercelRequest, res: VercelResponse): boolean {
  const secret = process.env.CRM_SYNC_SECRET;
  if (!secret) {
    res.status(503).json({
      error: 'CRM_SYNC_SECRET is not configured. Add it in Vercel → Settings → Environment Variables.',
    });
    return false;
  }

  const auth = req.headers.authorization;
  if (auth !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }

  return true;
}
