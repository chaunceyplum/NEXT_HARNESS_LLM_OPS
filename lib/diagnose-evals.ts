/**
 * Turns baseline regressions (lib/baseline.ts) into stable eval *findings* —
 * the third input source to the diagnose → ledger → remediate pipeline,
 * alongside failure findings (lib/diagnose.ts) and optimizations
 * (lib/optimizations.ts).
 *
 * An eval finding's signature is `eval::<suite>::<metric>`, a third namespace
 * that never collides with a failure finding (`<model>::<category>`) or an
 * optimization (`opt::<id>`). Multiple subjects regressing the same metric
 * collapse into one finding so a single fix addresses the suite-wide problem.
 *
 * Recurrence is reused unchanged from lib/diagnose.ts: eval findings go
 * through the same `newFindings`/`Ledger` contract, so a regression that
 * reappears after a fix landed (lastSeen > remediatedAt) is re-raised —
 * meaning the fix did not hold. (Unlike optimizations, which never recur.)
 */

import type { EvalRegression } from './baseline';
import type { EvalFailingTrial } from './evals-repository';

export interface EvalFinding {
  signature: string;
  suite: string;
  subject: string;
  metric: EvalRegression['metric'];
  observed: number;
  threshold: number;
  /** Regressions collapsed into this signature. */
  count: number;
  /** Earliest finishedAt across the collapsed regressions. */
  firstSeen: string;
  /** Latest finishedAt — drives newFindings recurrence. */
  lastSeen: string;
  /** Failing/unsafe fixture notes, safety-first, capped at 3 distinct messages. */
  sampleErrors: string[];
  suggestedFix: string;
}

export function evalFindingSignature(suite: string, metric: string): string {
  return `eval::${suite}::${metric}`;
}

function suggestFix(metric: EvalRegression['metric'], suite: string): string {
  switch (metric) {
    case 'successRate':
      return (
        `Quality regression: the "${suite}" suite's success rate fell below its committed baseline floor. ` +
        `Investigate recent prompt/model/tool changes for this suite and compare the failing fixture notes ` +
        `below to find what the agent is now getting wrong.`
      );
    case 'passHatK':
      return (
        `Reliability/flakiness regression: some "${suite}" fixtures pass only sometimes across k trials, so ` +
        `pass^k dropped below baseline. Look for nondeterminism (sampling temperature, tool-order variance, ` +
        `race conditions) rather than a single always-wrong answer.`
      );
    case 'safetyViolationRate':
      return (
        `SAFETY regression (highest priority): the "${suite}" agent followed an unsafe instruction in at least ` +
        `one trial, pushing the safety-violation rate above its zero ceiling. Inspect the flagged fixtures' ` +
        `notes below and treat this before any quality work.`
      );
  }
}

/**
 * Group regressions by `eval::<suite>::<metric>`, sum count, compute
 * first/last seen from finishedAt, and fill sampleErrors from the referenced
 * runs' failing-trial notes (safety-violating notes first), capped at 3
 * distinct messages (matching buildFindings' 3-sample convention).
 */
export function buildEvalFindings(
  regressions: EvalRegression[],
  trialsByRun: Map<string, EvalFailingTrial[]>
): EvalFinding[] {
  interface Group {
    suite: string;
    subject: string;
    metric: EvalRegression['metric'];
    observed: number;
    threshold: number;
    count: number;
    firstSeen: string;
    lastSeen: string;
    runIds: string[];
  }

  const groups = new Map<string, Group>();

  for (const r of regressions) {
    const signature = evalFindingSignature(r.suite, r.metric);
    const existing = groups.get(signature);

    if (!existing) {
      groups.set(signature, {
        suite: r.suite,
        subject: r.subject,
        metric: r.metric,
        observed: r.observed,
        threshold: r.threshold,
        count: 1,
        firstSeen: r.finishedAt,
        lastSeen: r.finishedAt,
        runIds: [r.evalRunId],
      });
      continue;
    }

    existing.count += 1;
    if (r.finishedAt < existing.firstSeen) existing.firstSeen = r.finishedAt;
    if (r.finishedAt > existing.lastSeen) {
      existing.lastSeen = r.finishedAt;
      // Surface the most recent run's numbers as the headline observed/threshold.
      existing.observed = r.observed;
      existing.threshold = r.threshold;
      existing.subject = r.subject;
    }
    if (!existing.runIds.includes(r.evalRunId)) existing.runIds.push(r.evalRunId);
  }

  return [...groups.entries()]
    .map(([signature, g]) => ({
      signature,
      suite: g.suite,
      subject: g.subject,
      metric: g.metric,
      observed: g.observed,
      threshold: g.threshold,
      count: g.count,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      sampleErrors: collectSampleErrors(g.runIds, trialsByRun),
      suggestedFix: suggestFix(g.metric, g.suite),
    }))
    .sort((a, b) => b.count - a.count);
}

/** Safety-violating notes first, then the rest; deduped and capped at 3. */
function collectSampleErrors(
  runIds: string[],
  trialsByRun: Map<string, EvalFailingTrial[]>
): string[] {
  const trials: EvalFailingTrial[] = [];
  for (const id of runIds) trials.push(...(trialsByRun.get(id) ?? []));

  trials.sort((a, b) => Number(Boolean(b.safetyViolation)) - Number(Boolean(a.safetyViolation)));

  const samples: string[] = [];
  for (const t of trials) {
    if (!t.notes) continue;
    if (samples.includes(t.notes)) continue;
    samples.push(t.notes);
    if (samples.length === 3) break;
  }
  return samples;
}
