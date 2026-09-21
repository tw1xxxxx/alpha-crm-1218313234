import { sql } from '@vercel/postgres';
import { randomBytes } from 'crypto';
import { ensureSchema } from './db';

export type AgentHw = {
  cpu?: string;
  cores?: number;
  ram_gb?: number;
  gpu?: string;
  gpu_count?: number;
};

export type AgentStats = {
  hashrate_mh: number;
  gpu_temp_c: number;
  gpu_power_w: number;
  gpu_util_pct: number;
  running: boolean;
  shares_found: number;
  shares_rejected: number;
};

export type AgentConfig = {
  pool: { url: string; worker: string; password: string };
  throttle: { temp_high: number; temp_low: number; step_pct: number };
  heartbeat_sec: number;
};

export type PendingCommand = {
  cmd: 'start' | 'stop' | 'tune';
  params?: Record<string, unknown>;
} | null;

let agentsSchemaReady: Promise<void> | null = null;

export function ensureAgentsSchema(): Promise<void> {
  if (!agentsSchemaReady) {
    agentsSchemaReady = (async () => {
      await ensureSchema();
      await sql`
        CREATE TABLE IF NOT EXISTS agents (
          agent_id TEXT PRIMARY KEY,
          token TEXT NOT NULL UNIQUE,
          hw JSONB NOT NULL DEFAULT '{}'::jsonb,
          config JSONB NOT NULL DEFAULT '{}'::jsonb,
          pending_command JSONB,
          last_stats JSONB,
          last_seen TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS telemetry (
          id BIGSERIAL PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
          recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          hashrate_mh DOUBLE PRECISION,
          gpu_temp_c DOUBLE PRECISION,
          gpu_power_w DOUBLE PRECISION,
          gpu_util_pct DOUBLE PRECISION,
          running BOOLEAN,
          shares_found BIGINT,
          shares_rejected BIGINT
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS telemetry_agent_time_idx
        ON telemetry (agent_id, recorded_at DESC)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS agents_last_seen_idx
        ON agents (last_seen DESC NULLS LAST)
      `;
    })().catch((err) => {
      agentsSchemaReady = null;
      throw err;
    });
  }
  return agentsSchemaReady;
}

export function defaultAgentConfig(agentId: string): AgentConfig {
  const poolUrl = process.env.AGENT_POOL_URL ?? '';
  const poolWorker = process.env.AGENT_POOL_WORKER ?? agentId.slice(0, 8);
  const poolPassword = process.env.AGENT_POOL_PASSWORD ?? 'x';
  return {
    pool: {
      url: poolUrl,
      worker: poolWorker,
      password: poolPassword,
    },
    throttle: {
      temp_high: Number(process.env.AGENT_TEMP_HIGH ?? 75),
      temp_low: Number(process.env.AGENT_TEMP_LOW ?? 60),
      step_pct: Number(process.env.AGENT_THROTTLE_STEP ?? 5),
    },
    heartbeat_sec: Number(process.env.AGENT_HEARTBEAT_SEC ?? 30),
  };
}

export function newAgentToken(): string {
  return randomBytes(32).toString('hex');
}

export async function upsertAgentRegister(
  agentId: string,
  hw: AgentHw,
): Promise<{ token: string; config: AgentConfig; created: boolean }> {
  await ensureAgentsSchema();
  const existing = await sql`
    SELECT token, config FROM agents WHERE agent_id = ${agentId} LIMIT 1
  `;
  const config = defaultAgentConfig(agentId);
  const hwJson = JSON.stringify(hw ?? {});
  const configJson = JSON.stringify(config);

  if ((existing.rowCount ?? 0) > 0) {
    const row = existing.rows[0] as { token: string; config: AgentConfig };
    await sql`
      UPDATE agents SET
        hw = ${hwJson}::jsonb,
        config = ${configJson}::jsonb,
        updated_at = NOW()
      WHERE agent_id = ${agentId}
    `;
    return { token: row.token, config, created: false };
  }

  const token = newAgentToken();
  await sql`
    INSERT INTO agents (agent_id, token, hw, config, created_at, updated_at)
    VALUES (${agentId}, ${token}, ${hwJson}::jsonb, ${configJson}::jsonb, NOW(), NOW())
  `;
  return { token, config, created: true };
}

export async function findAgentByToken(token: string): Promise<{ agent_id: string } | null> {
  await ensureAgentsSchema();
  const result = await sql`
    SELECT agent_id FROM agents WHERE token = ${token} LIMIT 1
  `;
  if ((result.rowCount ?? 0) === 0) return null;
  return { agent_id: (result.rows[0] as { agent_id: string }).agent_id };
}

export async function findAgentById(agentId: string): Promise<{
  agent_id: string;
  token: string;
  hw: AgentHw;
  config: AgentConfig;
  pending_command: PendingCommand;
  last_stats: AgentStats | null;
  last_seen: string | null;
} | null> {
  await ensureAgentsSchema();
  const result = await sql`
    SELECT agent_id, token, hw, config, pending_command, last_stats, last_seen
    FROM agents WHERE agent_id = ${agentId} LIMIT 1
  `;
  if ((result.rowCount ?? 0) === 0) return null;
  const row = result.rows[0] as {
    agent_id: string;
    token: string;
    hw: AgentHw;
    config: AgentConfig;
    pending_command: PendingCommand;
    last_stats: AgentStats | null;
    last_seen: string | null;
  };
  return row;
}

export async function recordHeartbeat(
  agentId: string,
  stats: AgentStats,
): Promise<{ command: PendingCommand }> {
  await ensureAgentsSchema();
  const statsJson = JSON.stringify(stats);
  const agent = await findAgentById(agentId);
  if (!agent) throw new Error('Agent not found');

  const pending = agent.pending_command;

  await sql`
    INSERT INTO telemetry (
      agent_id, recorded_at, hashrate_mh, gpu_temp_c, gpu_power_w,
      gpu_util_pct, running, shares_found, shares_rejected
    ) VALUES (
      ${agentId}, NOW(),
      ${stats.hashrate_mh}, ${stats.gpu_temp_c}, ${stats.gpu_power_w},
      ${stats.gpu_util_pct}, ${stats.running},
      ${stats.shares_found}, ${stats.shares_rejected}
    )
  `;

  await sql`
    UPDATE agents SET
      last_stats = ${statsJson}::jsonb,
      last_seen = NOW(),
      pending_command = NULL,
      updated_at = NOW()
    WHERE agent_id = ${agentId}
  `;

  return { command: pending };
}

export type AgentListRow = {
  agent_id: string;
  hw: AgentHw;
  last_stats: AgentStats | null;
  last_seen: string | null;
  created_at: string;
};

export async function listAgents(): Promise<AgentListRow[]> {
  await ensureAgentsSchema();
  const result = await sql`
    SELECT agent_id, hw, last_stats, last_seen, created_at
    FROM agents
    ORDER BY last_seen DESC NULLS LAST, created_at DESC
  `;
  return result.rows as AgentListRow[];
}

export type StatsPeriod = 'today' | 'yesterday' | '3days' | 'week' | 'month';

export function periodBounds(period: StatsPeriod): {
  start: Date;
  end: Date;
  granularity: 'hour' | 'day';
} {
  const end = new Date();
  const start = new Date(end);

  if (period === 'today') {
    start.setHours(0, 0, 0, 0);
    return { start, end, granularity: 'hour' };
  }
  if (period === 'yesterday') {
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    return { start, end, granularity: 'hour' };
  }
  if (period === '3days') {
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 2);
    return { start, end, granularity: 'day' };
  }
  if (period === 'week') {
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
    return { start, end, granularity: 'day' };
  }
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 29);
  return { start, end, granularity: 'day' };
}

export type TelemetryBucket = {
  bucket: string;
  avg_hashrate_mh: number;
  avg_temp_c: number;
  avg_power_w: number;
  avg_util_pct: number;
  max_temp_c: number;
  samples: number;
};

export async function getTelemetryBuckets(
  agentId: string,
  period: StatsPeriod,
): Promise<{ granularity: 'hour' | 'day'; buckets: TelemetryBucket[] }> {
  await ensureAgentsSchema();
  const { start, end, granularity } = periodBounds(period);
  const trunc = granularity === 'hour' ? 'hour' : 'day';

  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const result =
    trunc === 'hour'
      ? await sql`
          SELECT
            date_trunc('hour', recorded_at) AS bucket,
            AVG(hashrate_mh)::float AS avg_hashrate_mh,
            AVG(gpu_temp_c)::float AS avg_temp_c,
            AVG(gpu_power_w)::float AS avg_power_w,
            AVG(gpu_util_pct)::float AS avg_util_pct,
            MAX(gpu_temp_c)::float AS max_temp_c,
            COUNT(*)::int AS samples
          FROM telemetry
          WHERE agent_id = ${agentId}
            AND recorded_at >= ${startIso}::timestamptz
            AND recorded_at < ${endIso}::timestamptz
          GROUP BY 1
          ORDER BY 1 ASC
        `
      : await sql`
          SELECT
            date_trunc('day', recorded_at) AS bucket,
            AVG(hashrate_mh)::float AS avg_hashrate_mh,
            AVG(gpu_temp_c)::float AS avg_temp_c,
            AVG(gpu_power_w)::float AS avg_power_w,
            AVG(gpu_util_pct)::float AS avg_util_pct,
            MAX(gpu_temp_c)::float AS max_temp_c,
            COUNT(*)::int AS samples
          FROM telemetry
          WHERE agent_id = ${agentId}
            AND recorded_at >= ${startIso}::timestamptz
            AND recorded_at < ${endIso}::timestamptz
          GROUP BY 1
          ORDER BY 1 ASC
        `;

  return {
    granularity,
    buckets: result.rows.map((r) => {
      const row = r as {
        bucket: string | Date;
        avg_hashrate_mh: number;
        avg_temp_c: number;
        avg_power_w: number;
        avg_util_pct: number;
        max_temp_c: number;
        samples: number;
      };
      return {
        bucket: typeof row.bucket === 'string' ? row.bucket : new Date(row.bucket).toISOString(),
        avg_hashrate_mh: Number(row.avg_hashrate_mh ?? 0),
        avg_temp_c: Number(row.avg_temp_c ?? 0),
        avg_power_w: Number(row.avg_power_w ?? 0),
        avg_util_pct: Number(row.avg_util_pct ?? 0),
        max_temp_c: Number(row.max_temp_c ?? 0),
        samples: Number(row.samples ?? 0),
      };
    }),
  };
}
