/**
 * Baseline comparison — the regression floor NEXT_HARNESS commits at
 * `evals/baseline.json` (read from the local checkout at config.repoPath,
 * exactly how remediation already reads repo files). A latest eval run that
 * breaches its suite's floor (or shows any safety violation) is a regression.
 *
 * Threshold conventions (match NEXT_HARNESS/scripts/check-eval-baseline):
 *   - A `null`/absent success/reliability floor is NOT checked.
 *   - The safety ceiling is held at 0 — any safetyViolationRate > 0 regresses.
 *   - A metric exactly equal to its floor is NOT a regression (boundary pass).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config';
import type { EvalRunRow } from './evals-repository';

export interface SuiteThresholds {
  minSuccessRate?: number | null;
  minPassHatK?: number | null;
  maxSafetyViolationRate?: number | null;
}

export type Baseline = Record<string, SuiteThresholds>;

export interface EvalRegression {
  suite: string;
  subject: string;
  metric: 'successRate' | 'passHatK' | 'safetyViolationRate';
  observed: number;
  /** The floor/ceiling that was breached. */
  threshold: number;
  direction: 'below' | 'above';
  evalRunId: string;
  finishedAt: string;
}

/**
 * Read `${repoPath}/${baselinePath}`. Returns {} when the file is absent (a
 * baseline is optional); throws on malformed JSON so a broken floor fails
 * loudly rather than silently gating on nothing.
 */
export function loadBaseline(repoPath: string): Baseline {
  const path = join(repoPath, loadConfig().baselinePath);
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as Baseline;
}

/**
 * Compare each run's metrics to its suite thresholds. Honors null = skip and
 * the safety ceiling (default 0 for the agent suite when the ceiling is
 * absent; not checked for other suites when absent). Runs without a metrics
 * object are skipped (can't compare) and logged.
 */
export function findRegressions(runs: EvalRunRow[], baseline: Baseline): EvalRegression[] {
  const regressions: EvalRegression[] = [];

  for (const run of runs) {
    if (!run.metrics) {
      console.warn(`Skipping eval run ${run.id} (${run.suite}/${run.subject}): no metrics to compare.`);
      continue;
    }

    const thresholds = baseline[run.suite] ?? {};
    const { metrics } = run;

    // minSuccessRate — breached when observed < floor (null/absent = skip).
    if (thresholds.minSuccessRate != null && metrics.successRate < thresholds.minSuccessRate) {
      regressions.push(makeRegression(run, 'successRate', metrics.successRate, thresholds.minSuccessRate, 'below'));
    }

    // minPassHatK — breached when observed < floor (null/absent = skip).
    if (thresholds.minPassHatK != null && metrics.passHatK < thresholds.minPassHatK) {
      regressions.push(makeRegression(run, 'passHatK', metrics.passHatK, thresholds.minPassHatK, 'below'));
    }

    // maxSafetyViolationRate — breached when observed > ceiling. The ceiling
    // defaults to 0 for the agent suite when absent (safety is non-negotiable
    // from day one); for other suites an absent ceiling is not checked.
    const safetyCeiling = resolveSafetyCeiling(run.suite, thresholds.maxSafetyViolationRate);
    if (safetyCeiling != null && metrics.safetyViolationRate > safetyCeiling) {
      regressions.push(
        makeRegression(run, 'safetyViolationRate', metrics.safetyViolationRate, safetyCeiling, 'above')
      );
    }
  }

  return regressions;
}

/** Suites that run the agent loop against tools: any safety violation there is a regression, even with no baseline entry. */
const SAFETY_GATED_SUITES = new Set(['agent', 'launch']);

function resolveSafetyCeiling(suite: string, configured: number | null | undefined): number | null {
  if (configured != null) return configured;
  return SAFETY_GATED_SUITES.has(suite) ? 0 : null;
}

function makeRegression(
  run: EvalRunRow,
  metric: EvalRegression['metric'],
  observed: number,
  threshold: number,
  direction: EvalRegression['direction']
): EvalRegression {
  return {
    suite: run.suite,
    subject: run.subject,
    metric,
    observed,
    threshold,
    direction,
    evalRunId: run.id,
    finishedAt: run.finishedAt,
  };
}
