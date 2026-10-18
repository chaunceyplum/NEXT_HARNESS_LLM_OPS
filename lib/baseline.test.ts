import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRegressions, loadBaseline, type Baseline } from './baseline';
import type { EvalRunMetrics, EvalRunRow } from './evals-repository';

function metrics(overrides: Partial<EvalRunMetrics> = {}): EvalRunMetrics {
  return {
    fixtures: 10,
    trials: 10,
    errored: 0,
    k: 1,
    successRate: 1,
    passAtK: 1,
    passHatK: 1,
    safetyViolationRate: 0,
    safetyViolations: 0,
    ...overrides,
  };
}

function run(overrides: Partial<EvalRunRow> = {}): EvalRunRow {
  return {
    id: 'run-1',
    suite: 'agent',
    subject: 'default',
    passedCount: 10,
    totalCount: 10,
    trialsPerFixture: 1,
    startedAt: '2026-09-01T00:00:00.000Z',
    finishedAt: '2026-09-01T01:00:00.000Z',
    metrics: metrics(),
    ...overrides,
  };
}

describe('loadBaseline', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'llmops-baseline-'));
    mkdirSync(join(dir, 'evals'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns {} when the baseline file is absent', () => {
    expect(loadBaseline(dir)).toEqual({});
  });

  it('reads evals/baseline.json relative to repoPath', () => {
    const baseline = { agent: { minSuccessRate: 0.9, maxSafetyViolationRate: 0 } };
    writeFileSync(join(dir, 'evals', 'baseline.json'), JSON.stringify(baseline));
    expect(loadBaseline(dir)).toEqual(baseline);
  });

  it('throws on malformed JSON rather than silently gating on nothing', () => {
    writeFileSync(join(dir, 'evals', 'baseline.json'), '{ not valid json');
    expect(() => loadBaseline(dir)).toThrow();
  });
});

describe('findRegressions', () => {
  it('flags successRate below the floor', () => {
    const baseline: Baseline = { agent: { minSuccessRate: 0.9 } };
    const regressions = findRegressions([run({ metrics: metrics({ successRate: 0.8 }) })], baseline);
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toMatchObject({ metric: 'successRate', observed: 0.8, threshold: 0.9, direction: 'below' });
  });

  it('flags passHatK below the floor', () => {
    const baseline: Baseline = { agent: { minPassHatK: 0.75 } };
    const regressions = findRegressions([run({ metrics: metrics({ passHatK: 0.5 }) })], baseline);
    expect(regressions.map((r) => r.metric)).toEqual(['passHatK']);
  });

  it('does NOT flag a metric when its threshold is null (skip, not zero)', () => {
    const baseline: Baseline = { agent: { minSuccessRate: null, minPassHatK: null } };
    const regressions = findRegressions([run({ metrics: metrics({ successRate: 0.1, passHatK: 0.1 }) })], baseline);
    expect(regressions.filter((r) => r.metric !== 'safetyViolationRate')).toEqual([]);
  });

  it('flags any safetyViolationRate > 0 under the agent default ceiling of 0', () => {
    const baseline: Baseline = { agent: {} }; // no explicit ceiling -> defaults to 0 for agent
    const regressions = findRegressions([run({ metrics: metrics({ safetyViolationRate: 0.1 }) })], baseline);
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toMatchObject({ metric: 'safetyViolationRate', threshold: 0, direction: 'above' });
  });

  it('does NOT flag safetyViolationRate === 0', () => {
    const baseline: Baseline = { agent: { maxSafetyViolationRate: 0 } };
    expect(findRegressions([run({ metrics: metrics({ safetyViolationRate: 0 }) })], baseline)).toEqual([]);
  });

  it('does NOT check safety for a non-agent suite with no explicit ceiling', () => {
    const baseline: Baseline = { rag_judge: { minSuccessRate: 0.9 } };
    const regressions = findRegressions(
      [run({ suite: 'rag_judge', metrics: metrics({ successRate: 0.95, safetyViolationRate: 0.5 }) })],
      baseline
    );
    expect(regressions).toEqual([]);
  });

  it('treats a metric exactly equal to its floor as NOT a regression (boundary)', () => {
    const baseline: Baseline = { agent: { minSuccessRate: 0.9, minPassHatK: 0.8 } };
    const regressions = findRegressions(
      [run({ metrics: metrics({ successRate: 0.9, passHatK: 0.8 }) })],
      baseline
    );
    expect(regressions.filter((r) => r.metric !== 'safetyViolationRate')).toEqual([]);
  });

  it('skips runs with no metrics instead of crashing', () => {
    const baseline: Baseline = { agent: { minSuccessRate: 0.9 } };
    expect(findRegressions([run({ metrics: undefined })], baseline)).toEqual([]);
  });
});
