import { sql } from '@vercel/postgres';

let schemaReady: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS crm_store (
          store_key VARCHAR(64) PRIMARY KEY,
          payload JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS crm_store_updated_at_idx ON crm_store (updated_at DESC)
      `;
    })().catch(err => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

export async function getStoreKey(key: string): Promise<unknown[]> {
  await ensureSchema();
  const result = await sql`
    SELECT payload FROM crm_store WHERE store_key = ${key} LIMIT 1
  `;
  if (result.rowCount === 0) return [];
  const row = result.rows[0] as { payload: unknown };
  return Array.isArray(row.payload) ? row.payload : [];
}

export async function setStoreKey(key: string, payload: unknown[]): Promise<void> {
  await ensureSchema();
  const json = JSON.stringify(payload);
  await sql`
    INSERT INTO crm_store (store_key, payload, updated_at)
    VALUES (${key}, ${json}::jsonb, NOW())
    ON CONFLICT (store_key) DO UPDATE SET
      payload = EXCLUDED.payload,
      updated_at = NOW()
  `;
}

export async function getAllStore(): Promise<Record<string, unknown[]>> {
  await ensureSchema();
  const result = await sql`SELECT store_key, payload FROM crm_store`;
  const out: Record<string, unknown[]> = {};
  for (const row of result.rows) {
    const r = row as { store_key: string; payload: unknown };
    out[r.store_key] = Array.isArray(r.payload) ? r.payload : [];
  }
  return out;
}

export async function setBulkStore(data: Record<string, unknown[]>): Promise<void> {
  await ensureSchema();
  for (const [key, payload] of Object.entries(data)) {
    if (!Array.isArray(payload)) continue;
    await setStoreKey(key, payload);
  }
}

export async function pingDatabase(): Promise<boolean> {
  await ensureSchema();
  await sql`SELECT 1 AS ok`;
  return true;
}
