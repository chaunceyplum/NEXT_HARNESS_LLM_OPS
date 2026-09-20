/**
 * `npm run report` — prints the current failure/finding picture as markdown.
 * Read-only: this never touches NEXT_HARNESS or the ledger.
 */

import { loadEnvLocal } from '../lib/load-env';

loadEnvLocal();

import { loadConfig } from '../lib/config';
import { buildFindings, loadLedger, newFindings } from '../lib/diagnose';
import { loadOptimizations, optimizationSignature, pendingOptimizations } from '../lib/optimizations';
import { fetchFailedRuns, fetchRunTotals } from '../lib/runs-repository';

async function main() {
  const config = loadConfig();
  const [totals, failedRuns] = await Promise.all([fetchRunTotals(), fetchFailedRuns()]);
  const findings = buildFindings(failedRuns);
  const ledger = loadLedger();
  const unresolved = newFindings(findings, ledger);

  const optimizations = loadOptimizations(config.optimizationsDir);
  const pendingOpts = pendingOptimizations(optimizations, ledger);

  const lines: string[] = [];
  const rate = totals.total > 0 ? ((totals.failed / totals.total) * 100).toFixed(1) : '0.0';

  lines.push('# NEXT_HARNESS execution health');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`- Runs: ${totals.total} total, ${totals.failed} failed (${rate}%)`);
  lines.push(`- Findings: ${findings.length} (${unresolved.length} not yet remediated)`);
  lines.push(`- Optimizations: ${optimizations.length} in backlog (${pendingOpts.length} pending)`);
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

  console.log(lines.join('\n'));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
