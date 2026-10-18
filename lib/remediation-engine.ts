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
 * against the Anthropic Messages API (via @anthropic-ai/sdk — no external
 * CLI), giving the model a small set of tools scoped to a single target repo
 * checkout: read a file, write a file, list a directory, and run a shell
 * command (for grep/tests/git). The only requirement is an
 * `ANTHROPIC_API_KEY` and network access to the API — both of which a normal
 * CI runner or deploy host has.
 *
 * Guards (these limit mistakes; they are NOT a security sandbox — run_bash is
 * an arbitrary shell as the host user):
 * - read_file / write_file / list_directory resolve paths and refuse anything
 *   outside the target repo root.
 * - run_bash runs with the repo as cwd, a hard timeout, and an environment
 *   scrubbed of credentials (API keys, tokens, secrets) with git's persisted
 *   GitHub auth header blanked, and it refuses `git push` — so the model can't
 *   push or reach GitHub/Anthropic with the pipeline's credentials by
 *   accident. It can still read any file the host user can.
 * - Hard caps on model round-trips (`maxSteps`), total tokens
 *   (`maxTotalTokens`) and estimated spend (`maxBudgetUsd`).
 * - A turn cut off at max_tokens never runs its (possibly truncated) tool
 *   calls; a refusal stops the run.
 * - It only edits files and runs commands. It does NOT push, open PRs, or
 *   merge — the calling script (scripts/remediate.ts) owns those steps so
 *   they stay deterministic and auditable.
 */

import Anthropic from '@anthropic-ai/sdk';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute } from 'node:path';

/** Default engine model; REMEDIATE_ENGINE_MODEL overrides. */
export const DEFAULT_ENGINE_MODEL = 'claude-opus-5-5';

/** Per-MTok USD prices used for the budget guard ([input, output]). Unknown models are guarded by tokens only. */
const PRICES_PER_MTOK: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-fable-5-1': [10, 50],
};

/** Cap on a read_file result, so one huge file can't fill the context. */
const MAX_READ_CHARS = 200_000;

export interface EngineOptions {
  /** Absolute path to the target repo checkout the engine may edit. */
  repoPath: string;
  /** The task/prompt describing what to change. */
  prompt: string;
  /** Anthropic model id. Defaults to REMEDIATE_ENGINE_MODEL, then DEFAULT_ENGINE_MODEL. */
  model?: string;
  /** Max model round-trips before the loop is force-stopped. */
  maxSteps?: number;
  /** Stop once estimated spend (input + output, at PRICES_PER_MTOK) exceeds this many USD. */
  maxBudgetUsd?: number;
  /** Stop once total billed tokens (input incl. cache + output) exceed this. */
  maxTotalTokens?: number;
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
  /** Total tokens billed across the run (input incl. cache + output). */
  totalTokens: number;
  /** Estimated USD spend, when the model's price is known. */
  estimatedCostUsd?: number;
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
] satisfies Anthropic.Beta.BetaTool[];

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
  '- Before finishing, run the same checks the repo\'s CI runs on a pull request (read .github/workflows/ to find them — typically typecheck, lint, tests and build) via run_bash, and fix anything you broke. A PR that fails those checks cannot merge. If dependencies are not installed (no node_modules), install them first with the repo\'s lockfile command (e.g. npm ci).',
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
  const text = readFileSync(abs, 'utf-8');
  if (text.length <= MAX_READ_CHARS) return text;
  return (
    text.slice(0, MAX_READ_CHARS) +
    `\n\n[truncated: file is ${text.length} chars; showing the first ${MAX_READ_CHARS}. Use run_bash (sed -n, grep) to read the rest.]`
  );
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

/** Env var names that hold credentials the model's shell must not inherit. */
const SECRET_ENV_RE = /(TOKEN|SECRET|PASSWORD|API_KEY|_KEY$|^GH_|^GITHUB_|^ANTHROPIC_|^MCP_|^AWS_)/i;

/**
 * The environment run_bash runs with: the host env minus credentials, plus a
 * git config override that blanks the GitHub auth header actions/checkout
 * persists into the checkout's .git/config — so `git`/`curl` in the model's
 * shell can't reach GitHub with the pipeline's token.
 */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!SECRET_ENV_RE.test(k)) out[k] = v;
  }
  out.GIT_CONFIG_COUNT = '1';
  out.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
  out.GIT_CONFIG_VALUE_0 = '';
  out.GIT_TERMINAL_PROMPT = '0';
  return out;
}

const GIT_PUSH_RE = /\bgit\b[^\n;&|]*\bpush\b/;

function toolRunBash(repoRoot: string, input: Record<string, unknown>, timeoutMs: number): string {
  const command = String(input.command);
  if (GIT_PUSH_RE.test(command)) {
    return 'ERROR: git push is not allowed here — commit locally; the calling script pushes and opens the PR.';
  }
  try {
    const out = execFileSync('bash', ['-lc', command], {
      env: scrubbedEnv(),
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

/** Estimated USD for a usage block at the model's list price, or undefined when the price is unknown. */
function costOf(model: string, usage: Anthropic.Beta.BetaUsage): number | undefined {
  const price = PRICES_PER_MTOK[model];
  if (!price) return undefined;
  const [inPrice, outPrice] = price;
  const input =
    usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) * 1.25 + (usage.cache_read_input_tokens ?? 0) * 0.1;
  return (input * inPrice + usage.output_tokens * outPrice) / 1_000_000;
}

function tokensOf(usage: Anthropic.Beta.BetaUsage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  );
}

/** Drive the agentic loop to completion. Throws on API/auth errors, refusals, and exhausted limits. */
export async function runRemediationEngine(opts: EngineOptions): Promise<EngineResult> {
  const repoRoot = resolve(opts.repoPath);
  const model = opts.model || process.env.REMEDIATE_ENGINE_MODEL || DEFAULT_ENGINE_MODEL;
  const maxSteps = opts.maxSteps ?? 40;
  const maxBudgetUsd = opts.maxBudgetUsd ?? Number(process.env.REMEDIATE_MAX_BUDGET_USD || 3);
  const maxTotalTokens = opts.maxTotalTokens ?? Number(process.env.REMEDIATE_MAX_TOKENS || 3_000_000);
  const commandTimeoutMs = opts.commandTimeoutMs ?? 300_000;
  const log = opts.log ?? ((m: string) => console.log(m));
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set — the remediation engine needs it to call the Anthropic API. ' +
        '(Set it in .env.local or as a CI secret.)'
    );
  }

  const client = new Anthropic({ apiKey, ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}) });
  const written = new Set<string>();
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: opts.prompt }];

  let finalText = '';
  let totalTokens = 0;
  let costUsd: number | undefined = PRICES_PER_MTOK[model] ? 0 : undefined;
  const result = (steps: number): EngineResult => ({
    finalText,
    steps,
    filesWritten: [...written],
    totalTokens,
    estimatedCostUsd: costUsd,
  });

  for (let step = 0; step < maxSteps; step++) {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create({
        model,
        max_tokens: 16_000,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
        // The system prompt + tools are identical every turn and the history
        // only grows, so caching the prefix makes each later turn far cheaper.
        cache_control: { type: 'ephemeral' },
        output_config: { effort: 'high' },
        // Re-run a safety-classifier refusal on a fallback model instead of
        // stopping the remediation outright.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        throw new Error(`Anthropic API error: HTTP ${err.status ?? '?'} — ${err.message.slice(0, 500)}`);
      }
      throw err;
    }

    totalTokens += tokensOf(response.usage);
    const stepCost = costOf(model, response.usage);
    if (costUsd !== undefined && stepCost !== undefined) costUsd += stepCost;

    // Keep the full content (thinking blocks included) so history stays append-only.
    messages.push({ role: 'assistant', content: response.content });

    const textParts = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text');
    if (textParts.length > 0) finalText = textParts.map((t) => t.text).join('\n');
    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');

    if (response.stop_reason === 'refusal') {
      throw new Error(
        `The model declined to continue (refusal${response.stop_details?.category ? `: ${response.stop_details.category}` : ''}). ` +
          `Partial work may have been written (${written.size} file(s)); it was not committed by the engine.`
      );
    }

    if (totalTokens > maxTotalTokens || (costUsd !== undefined && costUsd > maxBudgetUsd)) {
      throw new Error(
        `Remediation engine stopped at its budget (${totalTokens} tokens` +
          (costUsd !== undefined ? `, ~$${costUsd.toFixed(2)} of $${maxBudgetUsd}` : '') +
          `). Partial work may have been written (${written.size} file(s)); it was not committed by the engine.`
      );
    }

    if (response.stop_reason === 'max_tokens') {
      // The turn was cut off: any tool call in it may carry a truncated input
      // (e.g. half a file), so none of them run. Each still needs a
      // tool_result; tell the model what happened so it retries smaller.
      const truncated = 'Your previous response hit the output limit and was cut off, so this call was NOT run. ' +
        'Retry it with less output per call (write large files in smaller pieces, or edit with run_bash).';
      messages.push({
        role: 'user',
        content: toolUses.length
          ? toolUses.map((tu) => ({ type: 'tool_result' as const, tool_use_id: tu.id, content: truncated, is_error: true }))
          : 'Your previous response hit the output limit and was cut off. Continue from where you stopped.',
      });
      continue;
    }

    if (response.stop_reason === 'pause_turn') {
      continue; // server paused a long turn; resend to resume
    }

    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return result(step + 1);
    }

    const toolResults = toolUses.map((tu) => {
      log(`  → ${tu.name}(${JSON.stringify(tu.input).slice(0, 120)})`);
      let content: string;
      try {
        content = dispatchTool(tu.name, tu.input as Record<string, unknown>, { repoRoot, written, commandTimeoutMs });
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
