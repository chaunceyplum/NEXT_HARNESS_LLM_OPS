import { describe, expect, it } from 'vitest';
import { ledgerPrUrls, parsePrUrl, prCarriesEvalFix, withoutOpenPrItems } from './pr-state';

const ledger = {
  'eval::agent::safetyViolationRate': { prUrl: 'https://github.com/o/r/pull/7', remediatedAt: '2026-10-01T00:00:00.000Z' },
  'bedrock:cheap::provider_access': { prUrl: 'https://github.com/o/r/pull/3', remediatedAt: '2026-09-01T00:00:00.000Z' },
};

describe('pr-state', () => {
  it('parses a PR url', () => {
    expect(parsePrUrl('https://github.com/o/r/pull/7')).toEqual({ owner: 'o', repo: 'r', number: 7 });
    expect(parsePrUrl('not a url')).toBeUndefined();
  });

  it('collects the distinct ledger PR urls for some signatures', () => {
    expect(ledgerPrUrls(['eval::agent::safetyViolationRate', 'nope', 'bedrock:cheap::provider_access'], ledger)).toEqual([
      'https://github.com/o/r/pull/7',
      'https://github.com/o/r/pull/3',
    ]);
  });

  it('drops recurring items whose fix PR is still open, keeps the rest', () => {
    const items = [{ s: 'eval::agent::safetyViolationRate' }, { s: 'bedrock:cheap::provider_access' }, { s: 'new::thing' }];
    const kept = withoutOpenPrItems(items, (i) => i.s, ledger, new Set(['https://github.com/o/r/pull/7']));
    expect(kept.map((i) => i.s)).toEqual(['bedrock:cheap::provider_access', 'new::thing']);
  });

  it('knows when a PR already carries an eval fix', () => {
    expect(prCarriesEvalFix('https://github.com/o/r/pull/7', ledger)).toBe(true);
    expect(prCarriesEvalFix('https://github.com/o/r/pull/3', ledger)).toBe(false);
  });
});
