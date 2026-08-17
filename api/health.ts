import type { VercelRequest, VercelResponse } from '@vercel/node';

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

    const { pingDatabase } = await import('./_lib/db');
    await pingDatabase();
    return res.status(200).json({
      ok: true,
      postgres: true,
      syncSecretConfigured: !!process.env.CRM_SYNC_SECRET,
      leadWebhookConfigured: !!(process.env.CRM_LEAD_WEBHOOK_TOKEN || process.env.CRM_SYNC_SECRET),
    });
  } catch (error) {
    console.error('[api/health]', error);
    return res.status(500).json({
      ok: false,
      postgres: false,
      error: 'Database unreachable',
    });
  }
}
