import { describe, expect, it } from 'vitest';
import type { Ledger } from './diagnose';
import { newFindings } from './diagnose';
import { optimizationSignature } from './optimizations';
import { findingSignature } from './diagnose';
import type { EvalRegression } from './baseline';
import type { EvalFailingTrial } from './evals-repository';
import { buildEvalFindings, evalFindingSignature } from './diagnose-evals';

function regression(overrides: Partial<EvalRegression> = {}): EvalRegression {
  return {
    suite: 'agent',
    subject: 'default',
    metric: 'successRate',
    observed: 0.5,
    threshold: 0.9,
    direction: 'below',
    evalRunId: 'run-1',
    finishedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function trial(overrides: Partial<EvalFailingTrial> = {}): EvalFailingTrial {
  return {
    evalRunId: 'run-1',
    fixtureId: 'fx-1',
    trial: 1,
    notes: 'a failing note',
    ...overrides,
  };
}

describe('evalFindingSignature', () => {
  it('uses the eval:: namespace', () => {
    expect(evalFindingSignature('agent', 'safetyViolationRate')).toBe('eval::agent::safetyViolationRate');
  });

  it('never collides with the failure-finding or optimization namespaces', () => {
    const sig = evalFindingSignature('agent', 'successRate');
    expect(sig).not.toBe(findingSignature('agent', 'unknown'));
    expect(sig).not.toBe(optimizationSignature({ id: 'agent' }));
    expect(sig.startsWith('eval::')).toBe(true);
  });
});

describe('buildEvalFindings', () => {
  it('groups multiple subjects of one metric into a single finding with summed count and correct first/last seen', () => {
    const regressions = [
      regression({ subject: 'alpha', evalRunId: 'r1', observed: 0.6, finishedAt: '2026-09-01T00:00:00.000Z' }),
      regression({ subject: 'beta', evalRunId: 'r2', observed: 0.4, finishedAt: '2026-09-03T00:00:00.000Z' }),
    ];
    const findings = buildEvalFindings(regressions, new Map());
    expect(findings).toHaveLength(1);
    expect(findings[0].signature).toBe('eval::agent::successRate');
    expect(findings[0].count).toBe(2);
    expect(findings[0].firstSeen).toBe('2026-09-01T00:00:00.000Z');
    expect(findings[0].lastSeen).toBe('2026-09-03T00:00:00.000Z');
    // headline observed comes from the most recent run
    expect(findings[0].observed).toBe(0.4);
  });

  it('keeps different metrics as distinct findings', () => {
    const findings = buildEvalFindings(
      [regression({ metric: 'successRate' }), regression({ metric: 'safetyViolationRate', direction: 'above' })],
      new Map()
    );
    expect(findings.map((f) => f.signature).sort()).toEqual([
      'eval::agent::safetyViolationRate',
      'eval::agent::successRate',
    ]);
  });

  it('fills sampleErrors from failing-trial notes, safety-violating notes first, capped at 3', () => {
    const trialsByRun = new Map<string, EvalFailingTrial[]>([
      [
        'run-1',
        [
          trial({ fixtureId: 'q', notes: 'quality fail A' }),
          trial({ fixtureId: 's', notes: 'SAFETY breach', safetyViolation: true }),
          trial({ fixtureId: 'q2', notes: 'quality fail B' }),
          trial({ fixtureId: 'q3', notes: 'quality fail C' }),
        ],
      ],
    ]);
    const findings = buildEvalFindings([regression({ evalRunId: 'run-1' })], trialsByRun);
    expect(findings[0].sampleErrors).toHaveLength(3);
    expect(findings[0].sampleErrors[0]).toBe('SAFETY breach'); // safety-first
  });

  it('dedupes identical notes when sampling', () => {
    const trialsByRun = new Map<string, EvalFailingTrial[]>([
      [
        'run-1',
        [trial({ notes: 'same note' }), trial({ fixtureId: 'b', notes: 'same note' }), trial({ fixtureId: 'c', notes: 'other' })],
      ],
    ]);
    const findings = buildEvalFindings([regression({ evalRunId: 'run-1' })], trialsByRun);
    expect(findings[0].sampleErrors).toEqual(['same note', 'other']);
  });

  it('gives safety regressions a highest-priority suggestedFix', () => {
    const findings = buildEvalFindings(
      [regression({ metric: 'safetyViolationRate', direction: 'above', observed: 0.2, threshold: 0 })],
      new Map()
    );
    expect(findings[0].suggestedFix).toMatch(/SAFETY/);
    expect(findings[0].suggestedFix).toMatch(/highest priority/i);
  });
});

describe('newFindings reused for eval findings', () => {
  it('excludes an eval finding remediated after its lastSeen', () => {
    const findings = buildEvalFindings([regression({ finishedAt: '2026-09-01T00:00:00.000Z' })], new Map());
    const ledger: Ledger = {
      'eval::agent::successRate': { prUrl: 'https://x/1', remediatedAt: '2026-09-05T00:00:00.000Z' },
    };
    expect(newFindings(findings, ledger)).toEqual([]);
  });

  it('re-includes an eval finding that recurred after its remediatedAt', () => {
    const findings = buildEvalFindings([regression({ finishedAt: '2026-09-10T00:00:00.000Z' })], new Map());
    const ledger: Ledger = {
      'eval::agent::successRate': { prUrl: 'https://x/1', remediatedAt: '2026-09-05T00:00:00.000Z' },
    };
    expect(newFindings(findings, ledger)).toEqual(findings);
  });
});
