/**
 * Read access to NEXT_HARNESS's eval history (`harness_eval_runs` /
 * `harness_eval_results`, created by NEXT_HARNESS/lib/eval-store.ts).
 * Read-only from this repo — the harness owns writes to these tables.
 *
 * Mirrors lib/runs-repository.ts: `execSql` wraps the MCP `execute_sql`
 * bridge, table names come from config, and every interpolated value is
 * escaped by hand through lib/sql.ts because execute_sql has NO parameter
 * binding.
 *
 * The eval shapes below are LOCAL mirrors of NEXT_HARNESS's definitions
 * (lib/eval-metrics.ts, lib/types.ts) — this repo has no @/lib access to the
 * sibling repo, so nothing is imported from it. The mappers read defensively
 * so a shape drift in the harness degrades gracefully instead of crashing.
 */

import { callMcpTool } from './mcp-client';
import { loadConfig } from './config';
import { sqlStr } from './sql';

/** LOCAL mirror of NEXT_HARNESS/lib/eval-metrics.ts EvalRunMetrics. */
export interface EvalRunMetrics {
  fixtures: number;
  trials: number;
  errored: number;
  k: number;
  successRate: number;
  passAtK: number;
  passHatK: number;
  toolCallAccuracy?: number;
  safetyViolationRate: number;
  safetyViolations: number;
  stepsMean?: number;
  latencyP50Ms?: number;
  latencyP95Ms?: number;
  totalCostUsd?: number;
  costPerSuccessUsd?: number;
  tokensPerSuccess?: number;
}

export interface EvalRunRow {
  id: string;
  suite: string;
  subject: string;
  judgeModel?: string;
  promptVersion?: string;
  passedCount: number;
  totalCount: number;
  trialsPerFixture: number;
  startedAt: string;
  finishedAt: string;
  /** Parsed from the `metrics` JSONB column; undefined when the column is null. */
  metrics?: EvalRunMetrics;
}

export interface EvalFailingTrial {
  evalRunId: string;
  fixtureId: string;
  trial: number;
  category?: string;
  notes: string;
  safetyViolation?: boolean;
  structuralPassed?: boolean;
}

interface ExecuteSqlResult {
  rows?: Array<Record<string, unknown>>;
}

/** Injectable for tests; defaults to the live MCP execute_sql bridge. */
export type SqlExecutor = (sql: string) => Promise<ExecuteSqlResult>;

async function defaultExec(sql: string): Promise<ExecuteSqlResult> {
  return (await callMcpTool('execute_sql', { sql })) as ExecuteSqlResult;
}

/** `metrics` can arrive as an already-parsed object or a JSON string; null => undefined. */
function parseMetrics(raw: unknown): EvalRunMetrics | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as EvalRunMetrics;
    } catch {
      return undefined;
    }
  }
  if (typeof raw === 'object') return raw as EvalRunMetrics;
  return undefined;
}

function rowToEvalRun(row: Record<string, unknown>): EvalRunRow {
  return {
    id: row.id as string,
    suite: row.suite as string,
    subject: row.subject as string,
    judgeModel: (row.judge_model as string | null) ?? undefined,
    promptVersion: (row.prompt_version as string | null) ?? undefined,
    passedCount: Number(row.passed_count ?? 0),
    totalCount: Number(row.total_count ?? 0),
    trialsPerFixture: Number(row.trials_per_fixture ?? 1),
    startedAt: new Date(row.started_at as string).toISOString(),
    finishedAt: new Date(row.finished_at as string).toISOString(),
    metrics: parseMetrics(row.metrics),
  };
}

function rowToFailingTrial(row: Record<string, unknown>): EvalFailingTrial {
  return {
    evalRunId: row.eval_run_id as string,
    fixtureId: row.fixture_id as string,
    trial: Number(row.trial ?? 1),
    category: (row.category as string | null) ?? undefined,
    notes: (row.notes as string | null) ?? '',
    safetyViolation: (row.safety_violation as boolean | null) ?? undefined,
    structuralPassed: (row.structural_passed as boolean | null) ?? undefined,
  };
}

/**
 * Latest eval run per (suite, subject), newest `finished_at` wins. Restricted
 * to `opts.suites` when given (each suite escaped via sqlStr). The exec is
 * injectable so tests can assert the generated SQL without a live bridge.
 */
export async function fetchLatestEvalRuns(
  opts: { suites?: string[]; exec?: SqlExecutor } = {}
): Promise<EvalRunRow[]> {
  const table = loadConfig().evalRunsTable;
  const exec = opts.exec ?? defaultExec;

  const suites = opts.suites?.filter(Boolean) ?? [];
  const whereSuite = suites.length > 0 ? ` WHERE suite IN (${suites.map(sqlStr).join(', ')})` : '';

  const result = await exec(
    `SELECT DISTINCT ON (suite, subject) ` +
      `id, suite, subject, judge_model, prompt_version, passed_count, total_count, ` +
      `trials_per_fixture, started_at, finished_at, metrics ` +
      `FROM ${table}${whereSuite} ` +
      `ORDER BY suite, subject, finished_at DESC`
  );

  return (result.rows ?? []).map(rowToEvalRun);
}

/**
 * Failing OR safety-violating trials for the given run ids — sample evidence
 * for the findings. Returns [] without issuing SQL for an empty id list.
 * Safety violations are surfaced first; capped by `limit` (default 50).
 */
export async function fetchFailingTrials(
  evalRunIds: string[],
  opts: { limit?: number; exec?: SqlExecutor } = {}
): Promise<EvalFailingTrial[]> {
  if (evalRunIds.length === 0) return [];

  const table = loadConfig().evalResultsTable;
  const exec = opts.exec ?? defaultExec;
  const limit = opts.limit ?? 50;
  const ids = evalRunIds.map(sqlStr).join(', ');

  const result = await exec(
    `SELECT eval_run_id, fixture_id, trial, category, notes, safety_violation, structural_passed ` +
      `FROM ${table} ` +
      `WHERE eval_run_id IN (${ids}) AND (passed = false OR safety_violation = true) ` +
      `ORDER BY safety_violation DESC NULLS LAST, eval_run_id, fixture_id, trial ` +
      `LIMIT ${Number(limit)}`
  );

  return (result.rows ?? []).map(rowToFailingTrial);
}
