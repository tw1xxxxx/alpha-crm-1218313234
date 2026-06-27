import type { VercelRequest, VercelResponse } from '@vercel/node';
import { pingDatabase } from '../_lib/db';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const hasPostgres = !!process.env.POSTGRES_URL;
    if (!hasPostgres) {
      return res.status(503).json({
        ok: false,
        postgres: false,
        message: 'POSTGRES_URL is not set. Create Vercel Postgres in Storage tab.',
      });
    }
    await pingDatabase();
    return res.status(200).json({
      ok: true,
      postgres: true,
      syncSecretConfigured: !!process.env.CRM_SYNC_SECRET,
    });
  } catch (error) {
    console.error('[api/health]', error);
    return res.status(500).json({ ok: false, error: 'Database unreachable' });
  }
}
