import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchTool, runRemediationEngine } from './remediation-engine';

describe('dispatchTool (sandboxed file tools)', () => {
  let repo: string;
  let written: Set<string>;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'engine-repo-'));
    written = new Set();
    writeFileSync(join(repo, 'existing.txt'), 'hello');
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, 'sub', 'nested.txt'), 'x');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const ctx = () => ({ repoRoot: repo, written, commandTimeoutMs: 5000 });

  it('reads an existing file', () => {
    expect(dispatchTool('read_file', { path: 'existing.txt' }, ctx())).toBe('hello');
  });

  it('reports a missing file instead of throwing', () => {
    expect(dispatchTool('read_file', { path: 'nope.txt' }, ctx())).toMatch(/does not exist/);
  });

  it('writes a new file (creating parent dirs) and records it', () => {
    const c = ctx();
    const res = dispatchTool('write_file', { path: 'deep/new.ts', content: 'export const x = 1;' }, c);
    expect(res).toMatch(/Wrote/);
    expect(readFileSync(join(repo, 'deep', 'new.ts'), 'utf-8')).toBe('export const x = 1;');
    expect([...c.written]).toContain('deep/new.ts');
  });

  it('lists a directory marking subdirs with a trailing slash', () => {
    const res = dispatchTool('list_directory', { path: '.' }, ctx());
    expect(res).toContain('existing.txt');
    expect(res).toContain('sub/');
  });

  it('runs a bash command with the repo as cwd', () => {
    const res = dispatchTool('run_bash', { command: 'cat existing.txt' }, ctx());
    expect(res).toMatch(/exit 0/);
    expect(res).toContain('hello');
  });

  it('captures a nonzero exit code rather than throwing', () => {
    const res = dispatchTool('run_bash', { command: 'exit 3' }, ctx());
    expect(res).toMatch(/exit 3/);
  });

  it('refuses to read outside the repo root', () => {
    expect(dispatchTool('read_file', { path: '../../etc/passwd' }, ctx())).toMatch(/refused/);
  });

  it('refuses to write outside the repo root', () => {
    expect(dispatchTool('write_file', { path: '../escape.txt', content: 'x' }, ctx())).toMatch(/refused/);
  });
});

describe('runRemediationEngine (mocked API)', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'engine-loop-'));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  function jsonResponse(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }

  it('drives a write via tool_use then finishes on the final text turn', async () => {
    const fetchImpl = vi
      .fn()
      // Turn 1: ask to write a file.
      .mockResolvedValueOnce(
        jsonResponse({
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'writing' },
            { type: 'tool_use', id: 'tu1', name: 'write_file', input: { path: 'fix.ts', content: 'export const ok = true;' } },
          ],
        })
      )
      // Turn 2: done.
      .mockResolvedValueOnce(
        jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done: added fix.ts' }] })
      );

    const result = await runRemediationEngine({
      repoPath: repo,
      prompt: 'add a fix',
      apiKey: 'test-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
    });

    expect(result.finalText).toMatch(/Done/);
    expect(result.filesWritten).toContain('fix.ts');
    expect(readFileSync(join(repo, 'fix.ts'), 'utf-8')).toBe('export const ok = true;');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws a clear error when no API key is available', async () => {
    await expect(
      runRemediationEngine({ repoPath: repo, prompt: 'x', apiKey: '', log: () => {} })
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('surfaces an API error response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'invalid x-api-key',
    } as Response);
    await expect(
      runRemediationEngine({
        repoPath: repo,
        prompt: 'x',
        apiKey: 'bad',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        log: () => {},
      })
    ).rejects.toThrow(/HTTP 401/);
  });

  it('stops at the step limit instead of looping forever', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'x', name: 'list_directory', input: { path: '.' } }],
      })
    );
    await expect(
      runRemediationEngine({
        repoPath: repo,
        prompt: 'loop',
        apiKey: 'k',
        maxSteps: 3,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        log: () => {},
      })
    ).rejects.toThrow(/step limit/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
