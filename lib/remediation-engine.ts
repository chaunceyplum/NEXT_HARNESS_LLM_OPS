/**
 * Self-contained remediation engine.
 *
 * This is what makes the pipeline actually autonomous. The original design
 * shelled out to an external `claude` CLI (`claude -p`), which meant the
 * fix-the-code step only worked on a host where that CLI happened to be
 * installed and authenticated — and it was never run end-to-end for exactly
 * that reason.
 *
 * This engine removes that dependency. It drives an agentic tool-use loop
 * directly against the Anthropic Messages API over `fetch` (no SDK, no CLI),
 * giving the model a small, sandboxed set of tools scoped to a single target
 * repo checkout: read a file, write a file, list a directory, and run a
 * shell command (for grep/tests/git). The only requirement is an
 * `ANTHROPIC_API_KEY` and network access to the API — both of which a normal
 * CI runner or deploy host has.
 *
 * It is deliberately conservative:
 * - All file paths are resolved and confined to the target repo root; an
 *   attempt to escape it is refused, not silently allowed.
 * - Shell commands run with the repo as cwd and a hard timeout.
 * - There is a hard cap on the number of model round-trips (`maxSteps`) so a
 *   confused run can't loop forever burning tokens.
 * - It only edits files and runs commands. It does NOT push, open PRs, or
 *   merge — the calling script (scripts/remediate.ts) owns those steps so
 *   they stay deterministic and auditable.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute } from 'node:path';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface EngineOptions {
  /** Absolute path to the target repo checkout the engine may edit. */
  repoPath: string;
  /** The task/prompt describing what to change. */
  prompt: string;
  /** Anthropic model id. Defaults to a current Sonnet. */
  model?: string;
  /** Max model round-trips before the loop is force-stopped. */
  maxSteps?: number;
  /** Per-shell-command timeout in ms. */
  commandTimeoutMs?: number;
  /** Sink for progress logs (defaults to console.log). */
  log?: (msg: string) => void;
  /** Injected fetch (for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected API key (for tests). Defaults to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
}

export interface EngineResult {
  /** The model's final natural-language summary of what it did. */
  finalText: string;
  /** Number of model round-trips consumed. */
  steps: number;
  /** Relative paths of files the engine wrote. */
  filesWritten: string[];
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
type AnthropicContentBlock = AnthropicToolUseBlock | AnthropicTextBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[] | Array<Record<string, unknown>>;
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: string;
}

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file relative to the repo root. Returns its full contents.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path relative to the repo root.' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a UTF-8 text file relative to the repo root, creating parent directories as needed. ' +
      'Provide the ENTIRE new file contents, not a diff.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the repo root.' },
        content: { type: 'string', description: 'The full new file contents.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List entries in a directory relative to the repo root. Returns names with a trailing / for dirs.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path relative to the repo root. Use "." for root.' } },
      required: ['path'],
    },
  },
  {
    name: 'run_bash',
    description:
      'Run a shell command with the repo root as the working directory (for grep, running tests, git add/commit, etc). ' +
      'Returns combined stdout+stderr and the exit code. Do not run interactive or long-running commands.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The shell command to run.' } },
      required: ['command'],
    },
  },
] as const;

const SYSTEM_PROMPT = [
  'You are an autonomous software engineer operating directly inside a git checkout of a target repository.',
  'You fix reliability issues and implement improvements by editing files and running the repo\'s own tooling.',
  '',
  'You have these tools: read_file, write_file, list_directory, run_bash. All paths are relative to the repo root.',
  '',
  'Working method:',
  '- Investigate before you change anything: list directories and read the relevant files first. Never write a file based on a guess about its current contents — read it first.',
  '- Make the smallest change that correctly addresses the task. Several findings may share one root cause; prefer one coherent fix over many scattered patches.',
  '- Where an issue is really an account/infrastructure problem no code can fix (e.g. a cloud provider model-access grant), document it in the appropriate place rather than inventing a code workaround.',
  '- Add or update tests next to the code you change, matching the repo\'s existing conventions.',
  '- Before finishing, run the repo\'s test command (and lint if it has one) via run_bash and fix anything you broke.',
  '- Then stage and commit your work with run_bash (git add + git commit) using a clear message. Do NOT push and do NOT open a pull request — that is handled for you after you finish.',
  '- Stay strictly scoped to the task. Do not refactor unrelated code.',
  '',
  'When you are completely done — changes made, tests passing, committed — stop calling tools and reply with a short summary of what you changed and why.',
].join('\n');

/** Resolve a repo-relative path and refuse anything that escapes the repo root. */
function safeResolve(repoRoot: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(repoRoot, p);
  const rel = relative(repoRoot, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path "${p}" resolves outside the repo root — refused.`);
  }
  return abs;
}

function toolReadFile(repoRoot: string, input: Record<string, unknown>): string {
  let abs: string;
  try {
    abs = safeResolve(repoRoot, String(input.path));
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!existsSync(abs)) return `ERROR: file does not exist: ${input.path}`;
  return readFileSync(abs, 'utf-8');
}

function toolWriteFile(repoRoot: string, input: Record<string, unknown>, written: Set<string>): string {
  const relPath = String(input.path);
  let abs: string;
  try {
    abs = safeResolve(repoRoot, relPath);
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, String(input.content), 'utf-8');
  written.add(relative(repoRoot, abs));
  return `Wrote ${String(input.content).length} bytes to ${relPath}`;
}

function toolListDirectory(repoRoot: string, input: Record<string, unknown>): string {
  let abs: string;
  try {
    abs = safeResolve(repoRoot, String(input.path));
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!existsSync(abs)) return `ERROR: directory does not exist: ${input.path}`;
  return readdirSync(abs)
    .sort()
    .map((name) => (statSync(resolve(abs, name)).isDirectory() ? `${name}/` : name))
    .join('\n');
}

function toolRunBash(repoRoot: string, input: Record<string, unknown>, timeoutMs: number): string {
  const command = String(input.command);
  try {
    const out = execFileSync('bash', ['-lc', command], {
      cwd: repoRoot,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return `exit 0\n${out}`.slice(0, 20000);
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    const body = `${e.stdout ?? ''}${e.stderr ?? ''}` || e.message || '';
    return `exit ${e.status ?? 1}\n${body}`.slice(0, 20000);
  }
}

export function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  ctx: { repoRoot: string; written: Set<string>; commandTimeoutMs: number }
): string {
  switch (name) {
    case 'read_file':
      return toolReadFile(ctx.repoRoot, input);
    case 'write_file':
      return toolWriteFile(ctx.repoRoot, input, ctx.written);
    case 'list_directory':
      return toolListDirectory(ctx.repoRoot, input);
    case 'run_bash':
      return toolRunBash(ctx.repoRoot, input, ctx.commandTimeoutMs);
    default:
      return `ERROR: unknown tool "${name}"`;
  }
}

/** Drive the agentic loop to completion. Throws on API/auth errors. */
export async function runRemediationEngine(opts: EngineOptions): Promise<EngineResult> {
  const repoRoot = resolve(opts.repoPath);
  const model = opts.model || process.env.REMEDIATE_ENGINE_MODEL || 'claude-sonnet-4-5-20250929';
  const maxSteps = opts.maxSteps ?? 40;
  const commandTimeoutMs = opts.commandTimeoutMs ?? 300_000;
  const log = opts.log ?? ((m: string) => console.log(m));
  const doFetch = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set — the remediation engine needs it to call the Anthropic API. ' +
        '(Set it in .env.local or as a CI secret.)'
    );
  }

  const written = new Set<string>();
  const messages: AnthropicMessage[] = [{ role: 'user', content: opts.prompt }];

  let finalText = '';
  let step = 0;

  for (; step < maxSteps; step++) {
    const response = await doFetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Anthropic API error: HTTP ${response.status} ${response.statusText} — ${body.slice(0, 500)}`);
    }

    const data = (await response.json()) as AnthropicResponse;
    messages.push({ role: 'assistant', content: data.content });

    const textParts = data.content.filter((b): b is AnthropicTextBlock => b.type === 'text');
    if (textParts.length > 0) {
      finalText = textParts.map((t) => t.text).join('\n');
    }

    const toolUses = data.content.filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use');

    if (data.stop_reason !== 'tool_use' || toolUses.length === 0) {
      // Model is done.
      return { finalText, steps: step + 1, filesWritten: [...written] };
    }

    const toolResults = toolUses.map((tu) => {
      log(`  → ${tu.name}(${JSON.stringify(tu.input).slice(0, 120)})`);
      let content: string;
      try {
        content = dispatchTool(tu.name, tu.input, { repoRoot, written, commandTimeoutMs });
      } catch (err) {
        content = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }
      return { type: 'tool_result' as const, tool_use_id: tu.id, content };
    });

    messages.push({ role: 'user', content: toolResults });
  }

  throw new Error(
    `Remediation engine hit the ${maxSteps}-step limit without finishing. ` +
      `Partial work may have been written (${written.size} file(s)); it was not committed by the engine.`
  );
}
