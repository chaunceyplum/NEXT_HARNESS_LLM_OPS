/**
 * Ledger <-> pull-request bookkeeping for scripts/remediate.ts.
 *
 * A work item is ledgered when its PR is OPENED (so a failed merge can't make
 * the next run redo the work), not when it merges. Two consequences these
 * helpers handle:
 *   - A finding that keeps recurring while its fix PR is still open (e.g. the
 *     nightly eval still fails because the fix hasn't merged) must not be
 *     re-filed onto that PR every run.
 *   - Every run reuses one branch/PR, so a later run's auto-merge would also
 *     merge work an earlier run left PR-only (eval fixes) — unless it checks
 *     what the PR already carries.
 */

import type { Ledger } from './diagnose';

/** "https://github.com/o/r/pull/12" -> { owner, repo, number }, or undefined. */
export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | undefined {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : undefined;
}

/** PR urls referenced by the ledger entries of these signatures. */
export function ledgerPrUrls(signatures: string[], ledger: Ledger): string[] {
  return [...new Set(signatures.map((s) => ledger[s]?.prUrl).filter((u): u is string => Boolean(u)))];
}

/** Drop items whose existing ledger PR is still open — their fix is filed, just not merged yet. */
export function withoutOpenPrItems<T>(items: T[], signatureOf: (item: T) => string, ledger: Ledger, openPrUrls: Set<string>): T[] {
  return items.filter((item) => {
    const prUrl = ledger[signatureOf(item)]?.prUrl;
    return !prUrl || !openPrUrls.has(prUrl);
  });
}

/** Whether an eval (quality/safety) fix is already recorded against this PR — it must then stay PR-only. */
export function prCarriesEvalFix(prUrl: string, ledger: Ledger): boolean {
  return Object.entries(ledger).some(([signature, entry]) => signature.startsWith('eval::') && entry.prUrl === prUrl);
}
