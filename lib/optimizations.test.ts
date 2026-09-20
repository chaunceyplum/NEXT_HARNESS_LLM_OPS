import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ledger } from './diagnose';
import {
  loadOptimizations,
  optimizationSignature,
  pendingOptimizations,
  type Optimization,
} from './optimizations';

function opt(overrides: Partial<Optimization> = {}): Optimization {
  return {
    id: 'sample-opt',
    title: 'A sample optimization',
    rationale: 'Because it makes things better',
    priority: 'medium',
    ...overrides,
  };
}

describe('optimizationSignature', () => {
  it('namespaces the id so it never collides with a failure finding signature', () => {
    expect(optimizationSignature({ id: 'add-caching' })).toBe('opt::add-caching');
  });
});

describe('loadOptimizations', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'llmops-opts-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] when the directory does not exist', () => {
    expect(loadOptimizations(join(dir, 'nope'))).toEqual([]);
  });

  it('loads a single-object file and applies the default priority', () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ id: 'a', title: 'A', rationale: 'r' }));
    const loaded = loadOptimizations(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].priority).toBe('medium');
  });

  it('loads an array file and orders by priority (high first)', () => {
    writeFileSync(
      join(dir, 'batch.json'),
      JSON.stringify([
        { id: 'low', title: 'L', rationale: 'r', priority: 'low' },
        { id: 'high', title: 'H', rationale: 'r', priority: 'high' },
        { id: 'mid', title: 'M', rationale: 'r' },
      ])
    );
    expect(loadOptimizations(dir).map((o) => o.id)).toEqual(['high', 'mid', 'low']);
  });

  it('throws on a malformed optimization file', () => {
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ title: 'missing id' }));
    expect(() => loadOptimizations(dir)).toThrow(/Invalid optimization file/);
  });

  it('throws on a duplicate id across files', () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ id: 'dup', title: 'A', rationale: 'r' }));
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ id: 'dup', title: 'B', rationale: 'r' }));
    expect(() => loadOptimizations(dir)).toThrow(/Duplicate optimization id/);
  });
});

describe('pendingOptimizations', () => {
  it('excludes optimizations already recorded in the ledger', () => {
    const optimizations = [opt({ id: 'done' }), opt({ id: 'todo' })];
    const ledger: Ledger = {
      [optimizationSignature({ id: 'done' })]: { prUrl: 'https://x/1', remediatedAt: '2026-09-01T00:00:00.000Z' },
    };
    expect(pendingOptimizations(optimizations, ledger).map((o) => o.id)).toEqual(['todo']);
  });

  it('treats an empty ledger as everything pending', () => {
    const optimizations = [opt({ id: 'one' }), opt({ id: 'two' })];
    expect(pendingOptimizations(optimizations, {})).toEqual(optimizations);
  });
});
