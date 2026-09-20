import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFindings, loadLedger, newFindings, saveLedger, type Ledger } from './diagnose';
import type { FailedRun } from './runs-repository';

function run(overrides: Partial<FailedRun>): FailedRun {
  return {
    id: 'run-id',
    createdAt: '2026-08-01T00:00:00.000Z',
    model: 'bedrock:balanced',
    error: '[chat model call (bedrock:balanced)] Forbidden',
    ...overrides,
  };
}

describe('buildFindings', () => {
  it('groups failures by model+category and counts them', () => {
    const findings = buildFindings([
      run({ id: '1', createdAt: '2026-08-01T00:00:00.000Z' }),
      run({ id: '2', createdAt: '2026-08-02T00:00:00.000Z' }),
      run({ id: '3', model: 'anthropic:haiku', error: '[chat model call (anthropic:haiku)] invalid x-api-key' }),
    ]);

    expect(findings).toHaveLength(2);
    const bedrock = findings.find((f) => f.model === 'bedrock:balanced')!;
    expect(bedrock.category).toBe('provider_access');
    expect(bedrock.count).toBe(2);
    expect(bedrock.firstSeen).toBe('2026-08-01T00:00:00.000Z');
    expect(bedrock.lastSeen).toBe('2026-08-02T00:00:00.000Z');

    const anthropic = findings.find((f) => f.model === 'anthropic:haiku')!;
    expect(anthropic.category).toBe('provider_auth');
    expect(anthropic.count).toBe(1);
  });

  it('sorts findings by count descending', () => {
    const findings = buildFindings([
      run({ id: '1', model: 'anthropic:haiku', error: '[chat model call (anthropic:haiku)] invalid x-api-key' }),
      run({ id: '2' }),
      run({ id: '3' }),
    ]);
    expect(findings[0].model).toBe('bedrock:balanced');
    expect(findings[0].count).toBe(2);
  });

  it('caps sample errors at 3 distinct messages', () => {
    const findings = buildFindings([
      run({ id: '1', error: 'error A' }),
      run({ id: '2', error: 'error B' }),
      run({ id: '3', error: 'error C' }),
      run({ id: '4', error: 'error D' }),
      run({ id: '5', error: 'error A' }),
    ]);
    expect(findings[0].sampleErrors).toHaveLength(3);
  });
});

describe('ledger round-trip + newFindings', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('loadLedger returns {} when the file does not exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'llmops-ledger-'));
    expect(loadLedger(join(dir, 'missing.json'))).toEqual({});
  });

  it('saveLedger then loadLedger round-trips', () => {
    dir = mkdtempSync(join(tmpdir(), 'llmops-ledger-'));
    const path = join(dir, 'ledger.json');
    const ledger: Ledger = { 'bedrock:balanced::provider_access': { prUrl: 'https://x/1', remediatedAt: '2026-09-01T00:00:00.000Z' } };
    saveLedger(ledger, path);
    expect(loadLedger(path)).toEqual(ledger);
  });

  it('newFindings excludes a finding already remediated after it last occurred', () => {
    const findings = buildFindings([run({ createdAt: '2026-08-01T00:00:00.000Z' })]);
    const ledger: Ledger = {
      [findings[0].signature]: { prUrl: 'https://x/1', remediatedAt: '2026-09-01T00:00:00.000Z' },
    };
    expect(newFindings(findings, ledger)).toEqual([]);
  });

  it('newFindings includes a finding that recurred after its remediation', () => {
    const findings = buildFindings([run({ createdAt: '2026-09-05T00:00:00.000Z' })]);
    const ledger: Ledger = {
      [findings[0].signature]: { prUrl: 'https://x/1', remediatedAt: '2026-09-01T00:00:00.000Z' },
    };
    expect(newFindings(findings, ledger)).toEqual(findings);
  });

  it('newFindings includes a finding never seen in the ledger', () => {
    const findings = buildFindings([run({})]);
    expect(newFindings(findings, {})).toEqual(findings);
  });
});
