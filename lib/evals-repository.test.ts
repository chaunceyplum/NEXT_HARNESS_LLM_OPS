import { describe, expect, it, vi } from 'vitest';
import { fetchFailingTrials, fetchLatestEvalRuns, type EvalRunMetrics } from './evals-repository';

const sampleMetrics: EvalRunMetrics = {
  fixtures: 5,
  trials: 10,
  errored: 0,
  k: 2,
  successRate: 0.8,
  passAtK: 0.9,
  passHatK: 0.7,
  safetyViolationRate: 0,
  safetyViolations: 0,
};

describe('fetchLatestEvalRuns', () => {
  it('selects the latest run per (suite, subject) via DISTINCT ON', async () => {
    const exec = vi.fn().mockResolvedValue({ rows: [] });
    await fetchLatestEvalRuns({ exec });
    const sql = exec.mock.calls[0][0] as string;
    expect(sql).toMatch(/SELECT DISTINCT ON \(suite, subject\)/);
    expect(sql).toMatch(/ORDER BY suite, subject, finished_at DESC/);
    expect(sql).not.toMatch(/WHERE/); // no suite filter when none given
  });

  it('escapes a suite name containing a single quote by doubling it (no raw interpolation)', async () => {
    const exec = vi.fn().mockResolvedValue({ rows: [] });
    await fetchLatestEvalRuns({ suites: ["o'brien", 'agent'], exec });
    const sql = exec.mock.calls[0][0] as string;
    expect(sql).toContain("suite IN ('o''brien', 'agent')");
    expect(sql).not.toContain("'o'brien'"); // the un-escaped form must never appear
  });

  it('maps rows and parses metrics arriving as an object', async () => {
    const exec = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'run-1',
          suite: 'agent',
          subject: 'default',
          judge_model: 'anthropic:haiku',
          prompt_version: 'v3',
          passed_count: 8,
          total_count: 10,
          trials_per_fixture: 2,
          started_at: '2026-09-01T00:00:00.000Z',
          finished_at: '2026-09-01T01:00:00.000Z',
          metrics: sampleMetrics,
        },
      ],
    });
    const [row] = await fetchLatestEvalRuns({ exec });
    expect(row.id).toBe('run-1');
    expect(row.judgeModel).toBe('anthropic:haiku');
    expect(row.trialsPerFixture).toBe(2);
    expect(row.metrics).toEqual(sampleMetrics);
  });

  it('parses metrics arriving as a JSON string', async () => {
    const exec = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'run-2',
          suite: 'agent',
          subject: 'default',
          passed_count: 8,
          total_count: 10,
          trials_per_fixture: 1,
          started_at: '2026-09-01T00:00:00.000Z',
          finished_at: '2026-09-01T01:00:00.000Z',
          metrics: JSON.stringify(sampleMetrics),
        },
      ],
    });
    const [row] = await fetchLatestEvalRuns({ exec });
    expect(row.metrics).toEqual(sampleMetrics);
  });

  it('leaves metrics undefined when the column is null', async () => {
    const exec = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'run-3',
          suite: 'agent',
          subject: 'default',
          passed_count: 0,
          total_count: 0,
          trials_per_fixture: 1,
          started_at: '2026-09-01T00:00:00.000Z',
          finished_at: '2026-09-01T01:00:00.000Z',
          metrics: null,
        },
      ],
    });
    const [row] = await fetchLatestEvalRuns({ exec });
    expect(row.metrics).toBeUndefined();
  });
});

describe('fetchFailingTrials', () => {
  it('returns [] without issuing SQL for an empty id list', async () => {
    const exec = vi.fn();
    expect(await fetchFailingTrials([], { exec })).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it('selects failing OR safety-violating trials, escaping ids and surfacing safety first', async () => {
    const exec = vi.fn().mockResolvedValue({ rows: [] });
    await fetchFailingTrials(["run'1", 'run-2'], { exec, limit: 25 });
    const sql = exec.mock.calls[0][0] as string;
    expect(sql).toContain("eval_run_id IN ('run''1', 'run-2')");
    expect(sql).toMatch(/passed = false OR safety_violation = true/);
    expect(sql).toMatch(/ORDER BY safety_violation DESC/);
    expect(sql).toMatch(/LIMIT 25/);
  });

  it('maps result rows into EvalFailingTrial objects', async () => {
    const exec = vi.fn().mockResolvedValue({
      rows: [
        {
          eval_run_id: 'run-1',
          fixture_id: 'fx-1',
          trial: 2,
          category: 'destructive',
          notes: 'followed unsafe instruction',
          safety_violation: true,
          structural_passed: false,
        },
      ],
    });
    const [t] = await fetchFailingTrials(['run-1'], { exec });
    expect(t).toEqual({
      evalRunId: 'run-1',
      fixtureId: 'fx-1',
      trial: 2,
      category: 'destructive',
      notes: 'followed unsafe instruction',
      safetyViolation: true,
      structuralPassed: false,
    });
  });
});
