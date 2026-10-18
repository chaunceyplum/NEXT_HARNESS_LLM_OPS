import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchTool, runRemediationEngine, scrubbedEnv } from './remediation-engine';

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

  const usage = { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  /** A Messages API response the SDK will parse (it needs a real Response and usage). */
  function jsonResponse(body: Record<string, unknown>): Response {
    return new Response(
      JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', usage, ...body }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
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
    const fetchImpl = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
    );
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
    const fetchImpl = vi.fn().mockImplementation(async () =>
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

  it('never runs a tool call from a turn cut off at max_tokens, and tells the model to retry smaller', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return bodies.length === 1
        ? jsonResponse({
            stop_reason: 'max_tokens',
            content: [{ type: 'tool_use', id: 'tu1', name: 'write_file', input: { path: 'half.ts', content: 'export const' } }],
          })
        : jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] });
    });

    const result = await runRemediationEngine({
      repoPath: repo,
      prompt: 'x',
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
    });

    expect(result.filesWritten).toEqual([]);
    expect(() => readFileSync(join(repo, 'half.ts'))).toThrow();
    const reply = bodies[1].messages.at(-1)!;
    expect(JSON.stringify(reply.content)).toMatch(/was NOT run/);
    expect(JSON.stringify(reply.content)).toMatch(/"is_error":true/);
  });

  it('stops on a refusal instead of treating it as done', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      jsonResponse({ stop_reason: 'refusal', content: [], stop_details: { type: 'refusal', category: 'cyber' } })
    );
    await expect(
      runRemediationEngine({ repoPath: repo, prompt: 'x', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, log: () => {} })
    ).rejects.toThrow(/declined.*cyber/);
  });

  it('stops once the estimated spend passes the budget', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      jsonResponse({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'x', name: 'list_directory', input: { path: '.' } }],
      })
    );
    // claude-opus-5-5 at $4/$20 per MTok: 1000 in + 500 out = $0.014 per turn.
    await expect(
      runRemediationEngine({
        repoPath: repo,
        prompt: 'x',
        apiKey: 'k',
        maxBudgetUsd: 0.03,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        log: () => {},
      })
    ).rejects.toThrow(/budget/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('sends the default model with effort, prompt caching and refusal fallbacks', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] });
    });
    const result = await runRemediationEngine({ repoPath: repo, prompt: 'x', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, log: () => {} });
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.output_config).toEqual({ effort: 'high' });
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.fallbacks).toBe('default');
    expect(result.totalTokens).toBe(1500);
    expect(result.estimatedCostUsd).toBeCloseTo(0.014);
  });
});

describe('run_bash guards', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'engine-bash-'));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));
  const ctx = () => ({ repoRoot: repo, written: new Set<string>(), commandTimeoutMs: 5000 });

  it('refuses git push', () => {
    expect(dispatchTool('run_bash', { command: 'git add -A && git push origin main' }, ctx())).toMatch(/not allowed/);
  });

  it('does not expose credentials to the shell', () => {
    process.env.GITHUB_TOKEN = 'ghp_secret';
    process.env.ANTHROPIC_API_KEY = 'sk-secret';
    try {
      const out = dispatchTool('run_bash', { command: 'env' }, ctx());
      expect(out).not.toContain('ghp_secret');
      expect(out).not.toContain('sk-secret');
    } finally {
      delete process.env.GITHUB_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('keeps ordinary env vars and blanks git\'s persisted GitHub auth header', () => {
    const env = scrubbedEnv({ PATH: '/bin', HOME: '/h', GH_PAT: 'x', MCP_API_KEY: 'y', AWS_SECRET_ACCESS_KEY: 'z' });
    expect(env.PATH).toBe('/bin');
    expect(env.HOME).toBe('/h');
    expect(env.GH_PAT).toBeUndefined();
    expect(env.MCP_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
  });

  it('truncates a huge read_file result with a note', () => {
    writeFileSync(join(repo, 'big.txt'), 'x'.repeat(250_000));
    const out = dispatchTool('read_file', { path: 'big.txt' }, ctx());
    expect(out.length).toBeLessThan(201_000);
    expect(out).toMatch(/truncated: file is 250000 chars/);
  });
});
