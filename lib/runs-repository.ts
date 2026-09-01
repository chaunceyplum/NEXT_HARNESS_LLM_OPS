/**
 * Read access to NEXT_HARNESS's execution history (`harness_agent_runs`,
 * created by NEXT_HARNESS/lib/execution-store.ts). Read-only from this repo
 * — the harness owns writes to this table.
 */

import { callMcpTool } from './mcp-client';
import { sqlTimestamp } from './sql';

const TABLE = 'harness_agent_runs';

interface ExecuteSqlResult {
  rows?: Array<Record<string, unknown>>;
}

async function execSql(sql: string): Promise<ExecuteSqlResult> {
  return (await callMcpTool('execute_sql', { sql })) as ExecuteSqlResult;
}

export interface FailedRun {
  id: string;
  createdAt: string;
  model: string;
  error: string;
}

export interface RunTotals {
  total: number;
  failed: number;
}

/** Every failed run's id/model/error, optionally restricted to runs created after `since`. */
export async function fetchFailedRuns(opts: { since?: Date } = {}): Promise<FailedRun[]> {
  const whereSince = opts.since ? ` AND created_at > ${sqlTimestamp(opts.since)}` : '';
  const result = await execSql(
    `SELECT id, created_at, model, error FROM ${TABLE} ` +
      `WHERE status = 'failed' AND error IS NOT NULL${whereSince} ` +
      `ORDER BY created_at DESC`
  );
  return (result.rows ?? []).map((row) => ({
    id: row.id as string,
    createdAt: new Date(row.created_at as string).toISOString(),
    model: row.model as string,
    error: row.error as string,
  }));
}

/** Overall run counts, optionally restricted to runs created after `since`. */
export async function fetchRunTotals(opts: { since?: Date } = {}): Promise<RunTotals> {
  const whereSince = opts.since ? ` WHERE created_at > ${sqlTimestamp(opts.since)}` : '';
  const result = await execSql(
    `SELECT count(*) AS total, count(*) FILTER (WHERE status = 'failed') AS failed FROM ${TABLE}${whereSince}`
  );
  const row = result.rows?.[0];
  return {
    total: Number(row?.total ?? 0),
    failed: Number(row?.failed ?? 0),
  };
}
