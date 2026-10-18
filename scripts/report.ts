/**
 * `npm run report` — prints the current failure/finding picture as markdown.
 * Read-only: this never touches NEXT_HARNESS or the ledger.
 */

import { loadEnvLocal } from '../lib/load-env';

loadEnvLocal();

import { loadConfig } from '../lib/config';
import { buildFindings, countNonActionable, loadLedger, newFindings } from '../lib/diagnose';
import { loadOptimizations, optimizationSignature, pendingOptimizations } from '../lib/optimizations';
import { fetchFailedRuns, fetchRunTotals } from '../lib/runs-repository';
import { fetchFailingTrials, fetchLatestEvalRuns, type EvalFailingTrial } from '../lib/evals-repository';
import { findRegressions, loadBaseline } from '../lib/baseline';
import { buildEvalFindings } from '../lib/diagnose-evals';

async function main() {
  const config = loadConfig();
  const [totals, failedRuns] = await Promise.all([fetchRunTotals(), fetchFailedRuns()]);
  const findings = buildFindings(failedRuns);
  const ledger = loadLedger();
  const unresolved = newFindings(findings, ledger);

  const optimizations = loadOptimizations(config.optimizationsDir);
  const pendingOpts = pendingOptimizations(optimizations, ledger);

  // Eval regressions (third input source): latest run per suite vs the
  // committed baseline floor. Read-only, like the rest of this script.
  const evalRuns = await fetchLatestEvalRuns({ suites: config.evalSuites });
  const baseline = loadBaseline(config.repoPath);
  const regressions = findRegressions(evalRuns, baseline);
  const regressingRunIds = [...new Set(regressions.map((r) => r.evalRunId))];
  const failingTrials = await fetchFailingTrials(regressingRunIds);
  const trialsByRun = new Map<string, EvalFailingTrial[]>();
  for (const t of failingTrials) {
    const list = trialsByRun.get(t.evalRunId) ?? [];
    list.push(t);
    trialsByRun.set(t.evalRunId, list);
  }
  const evalFindings = buildEvalFindings(regressions, trialsByRun);
  const unresolvedEvalFindings = newFindings(evalFindings, ledger);

  const lines: string[] = [];
  const rate = totals.total > 0 ? ((totals.failed / totals.total) * 100).toFixed(1) : '0.0';

  lines.push('# NEXT_HARNESS execution health');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`- Runs: ${totals.total} total, ${totals.failed} failed (${rate}%)`);
  const stopped = countNonActionable(failedRuns);
  if (stopped > 0) lines.push(`- Of the failed runs, ${stopped} were stopped on purpose (cancel / kill switch) and are not findings`);
  lines.push(`- Findings: ${findings.length} (${unresolved.length} not yet remediated)`);
  lines.push(`- Optimizations: ${optimizations.length} in backlog (${pendingOpts.length} pending)`);
  lines.push(
    `- Eval regressions: ${evalFindings.length} (${unresolvedEvalFindings.length} not yet remediated) ` +
      `across suites [${config.evalSuites.join(', ')}]`
  );
  lines.push('');

  if (findings.length === 0) {
    lines.push('No failures recorded.');
  } else {
    lines.push('| Signature | Count | First seen | Last seen | Remediated |');
    lines.push('|---|---|---|---|---|');
    for (const f of findings) {
      const entry = ledger[f.signature];
      const remediated = !entry ? '—' : f.lastSeen > entry.remediatedAt ? `recurred since ${entry.prUrl}` : entry.prUrl;
      lines.push(`| \`${f.signature}\` | ${f.count} | ${f.firstSeen} | ${f.lastSeen} | ${remediated} |`);
    }
    lines.push('');

    if (unresolved.length > 0) {
      lines.push('## Unresolved findings');
      lines.push('');
      for (const f of unresolved) {
        lines.push(`### \`${f.signature}\``);
        lines.push('');
        lines.push(f.suggestedFix);
        lines.push('');
        lines.push('Sample errors:');
        for (const err of f.sampleErrors) lines.push(`- \`${err}\``);
        lines.push('');
      }
    }
  }

  if (pendingOpts.length > 0) {
    lines.push('## Pending optimizations');
    lines.push('');
    for (const o of pendingOpts) {
      lines.push(`### \`${optimizationSignature(o)}\` — ${o.title} _(priority: ${o.priority})_`);
      lines.push('');
      lines.push(o.rationale);
      if (o.details) {
        lines.push('');
        lines.push(o.details);
      }
      lines.push('');
    }
  }

  if (evalFindings.length > 0) {
    lines.push('## Eval regressions');
    lines.push('');
    for (const f of evalFindings) {
      const entry = ledger[f.signature];
      const remediated = !entry ? '—' : f.lastSeen > entry.remediatedAt ? `recurred since ${entry.prUrl}` : entry.prUrl;
      lines.push(`### \`${f.signature}\` — ${f.suite}/${f.subject}`);
      lines.push('');
      lines.push(
        `- Metric: ${f.metric} (observed ${f.observed}, threshold ${f.threshold}) — ${f.count} regression(s)`
      );
      lines.push(`- First seen ${f.firstSeen}, last seen ${f.lastSeen} (remediated: ${remediated})`);
      lines.push('');
      lines.push(f.suggestedFix);
      if (f.sampleErrors.length > 0) {
        lines.push('');
        lines.push('Sample notes:');
        for (const note of f.sampleErrors) lines.push(`- \`${note}\``);
      }
      lines.push('');
    }
  }

  console.log(lines.join('\n'));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
