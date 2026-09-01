/**
 * `npm run remediate` — the actual fix-and-PR step of the pipeline.
 *
 * 1. Loads new (unremediated) findings — live from harness_agent_runs via
 *    lib/runs-repository.ts by default, or from a pre-fetched JSON file via
 *    --seed (useful where this process has no direct network path to the
 *    MCP endpoint but the data was already pulled through another path).
 * 2. If there are any, drives a single headless `claude -p` subprocess
 *    against a local NEXT_HARNESS checkout with all of them as its task —
 *    it investigates, fixes, adds tests, and commits locally. It does NOT
 *    push or open the PR itself; this script owns that step so it's
 *    deterministic and auditable.
 * 3. Pushes the branch and opens (or reuses, if one's already open from
 *    this branch) a pull request via the GitHub REST API.
 * 4. Records every remediated finding's signature -> PR url in
 *    remediation-ledger.json.
 *
 * This script makes the actual change to NEXT_HARNESS — it's not something
 * a human does by hand in a chat session, and it doesn't depend on any
 * Claude-Code-Remote-specific orchestration (session/trigger) tools; it
 * only needs `claude` on PATH, git, and a GITHUB_TOKEN with push/PR rights.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { loadEnvLocal } from '../lib/load-env';

loadEnvLocal();

import { buildFindings, loadLedger, newFindings, saveLedger, type Finding } from '../lib/diagnose';
import { fetchFailedRuns, type FailedRun } from '../lib/runs-repository';

interface Options {
  seedPath?: string;
  repoPath: string;
  branch: string;
  base: string;
  dryRun: boolean;
  maxBudgetUsd: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    repoPath: process.env.NEXT_HARNESS_PATH || '../NEXT_HARNESS',
    branch: process.env.NEXT_HARNESS_BRANCH || 'claude/llm-ops-pipeline-plan-23aa8s',
    base: process.env.NEXT_HARNESS_BASE_BRANCH || 'main',
    dryRun: false,
    maxBudgetUsd: process.env.REMEDIATE_MAX_BUDGET_USD || '3',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--seed') opts.seedPath = argv[++i];
    else if (arg === '--repo') opts.repoPath = argv[++i];
    else if (arg === '--branch') opts.branch = argv[++i];
    else if (arg === '--base') opts.base = argv[++i];
    else if (arg === '--dry-run') opts.dryRun = true;
  }
  return opts;
}

async function loadFailedRuns(opts: Options): Promise<FailedRun[]> {
  if (opts.seedPath) {
    return JSON.parse(readFileSync(opts.seedPath, 'utf-8')) as FailedRun[];
  }
  return fetchFailedRuns();
}

function buildPrompt(findings: Finding[]): string {
  const sections = findings.map((f) => [
    `### ${f.signature}`,
    `- Model: ${f.model}`,
    `- Category: ${f.category}`,
    `- Occurrences: ${f.count} (first seen ${f.firstSeen}, last seen ${f.lastSeen})`,
    `- Sample errors:`,
    ...f.sampleErrors.map((e) => `  - ${e}`),
    `- Suggested fix direction: ${f.suggestedFix}`,
  ].join('\n'));

  return [
    'You are fixing reliability issues in this repo (NEXT_HARNESS) that were diagnosed by the ' +
      'NEXT_HARNESS_LLM_OPS pipeline reading this app\'s own execution history table (harness_agent_runs). ' +
      'Each finding below is a real, recurring failure pattern from production runs — not a hypothetical.',
    '',
    'Findings to address:',
    '',
    ...sections,
    '',
    'Instructions:',
    '- Investigate the actual code before changing anything — do not apply a suggested fix blindly if the ' +
      'real cause turns out to be different once you look.',
    '- Several findings above likely share one root cause or fix (e.g. multiple provider-error findings across ' +
      'different models may all be addressed by the same model-health/fallback mechanism) — address the ' +
      'underlying causes with the minimum set of changes, not one patch per finding.',
    '- Where a finding is really an account/infrastructure problem no code change can fix (e.g. missing cloud ' +
      'provider model access), say so in a doc update rather than inventing a code workaround.',
    '- Add or update tests covering each change, matching this repo\'s existing vitest conventions ' +
      '(see *.test.ts files next to the modules they test).',
    '- Run `npm run lint` and `npm run test` and fix any failures before you finish.',
    '- Commit your changes with a clear, descriptive message (you may make more than one commit).',
    '- Do not push and do not open a pull request yourself — the calling script handles that after you finish.',
    '- Stay scoped to these findings. Do not refactor or fix unrelated things you notice along the way.',
  ].join('\n');
}

// Tools the headless agent actually needs to investigate, fix, test, and
// commit. Deliberately an allowlist (`--allowed-tools`) rather than
// `--permission-mode bypassPermissions`/`--dangerously-skip-permissions`:
// those disable the whole permission system, which Claude Code refuses to
// do for a process running as root (a real safeguard, not something to work
// around) — this repo is meant to run as a non-root deploy user on EC2
// (see docs/RUNBOOK.md), where that restriction doesn't even apply, but an
// explicit, minimal allowlist is the better default regardless of who's
// running it.
const REQUIRED_TOOLS = 'Read Edit Write Glob Grep Bash';

function runClaudeHeadless(prompt: string, cwd: string, maxBudgetUsd: string): void {
  execFileSync(
    'claude',
    [
      '-p', prompt,
      '--allowed-tools', REQUIRED_TOOLS,
      '--max-budget-usd', maxBudgetUsd,
      '--output-format', 'text',
    ],
    { cwd, stdio: 'inherit' }
  );
}

/** Claude Code refuses full permission bypasses as root; this script uses an allowlist instead (see REQUIRED_TOOLS), but running as a non-root deploy user is still the supported setup — see docs/RUNBOOK.md. */
function warnIfRoot(): void {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.warn(
      'Warning: running as root (uid 0). This should still work with the --allowed-tools allowlist this ' +
        'script uses, but the supported setup is a non-root deploy user (see docs/RUNBOOK.md) — some Claude ' +
        'Code permission modes are refused outright for root processes.'
    );
  }
}

function assertCleanCheckout(repoPath: string, branch: string): void {
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoPath }).toString().trim();
  if (status) {
    throw new Error(`${repoPath} has uncommitted changes — refusing to run remediation on a dirty checkout.`);
  }
  const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath }).toString().trim();
  if (currentBranch !== branch) {
    throw new Error(`${repoPath} is on branch "${currentBranch}", expected "${branch}".`);
  }
}

function hasNewCommits(repoPath: string, branch: string): boolean {
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoPath }).toString().trim();
  if (status) return true; // uncommitted changes claude left behind count as work done
  try {
    const ahead = execFileSync('git', ['rev-list', '--count', `origin/${branch}..${branch}`], { cwd: repoPath })
      .toString()
      .trim();
    return Number(ahead) > 0;
  } catch {
    return true; // no upstream yet (first push) — treat as "there's something to push"
  }
}

function gitPush(repoPath: string, branch: string): void {
  execFileSync('git', ['push', '-u', 'origin', branch], { cwd: repoPath, stdio: 'inherit' });
}

function parseOwnerRepo(repoPath: string): { owner: string; repo: string } {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath }).toString().trim();
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(\.git)?$/);
  if (!match) throw new Error(`Could not parse owner/repo from remote url: ${url}`);
  return { owner: match[1], repo: match[2] };
}

async function githubRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN (or GH_TOKEN) is not set — cannot open a pull request.');
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers,
    },
  });
}

async function findOpenPullRequest(owner: string, repo: string, branch: string): Promise<string | null> {
  const response = await githubRequest(`/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`);
  if (!response.ok) return null;
  const data = (await response.json()) as Array<{ html_url: string }>;
  return data[0]?.html_url ?? null;
}

async function openPullRequest(opts: {
  owner: string;
  repo: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}): Promise<string> {
  const response = await githubRequest(`/repos/${opts.owner}/${opts.repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title: opts.title, head: opts.branch, base: opts.base, body: opts.body }),
  });
  if (!response.ok) {
    throw new Error(`Failed to open PR: HTTP ${response.status} ${await response.text().catch(() => '')}`);
  }
  const data = (await response.json()) as { html_url: string };
  return data.html_url;
}

function prBody(findings: Finding[]): string {
  const lines = [
    'Opened by NEXT_HARNESS_LLM_OPS (`scripts/remediate.ts`) from findings diagnosed against the live ' +
      '`harness_agent_runs` table.',
    '',
    'Findings addressed:',
    '',
  ];
  for (const f of findings) {
    lines.push(`- \`${f.signature}\` — ${f.count} occurrence(s), ${f.firstSeen} to ${f.lastSeen}`);
  }
  lines.push('', '---', '_Generated by [Claude Code](https://claude.ai/code)_');
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const failedRuns = await loadFailedRuns(opts);
  const findings = buildFindings(failedRuns);
  const ledger = loadLedger();
  const unresolved = newFindings(findings, ledger);

  if (unresolved.length === 0) {
    console.log('No new findings to remediate.');
    return;
  }

  console.log(`${unresolved.length} new finding(s) to remediate:`);
  for (const f of unresolved) console.log(`  - ${f.signature} (${f.count} occurrences)`);

  const prompt = buildPrompt(unresolved);

  if (opts.dryRun) {
    console.log('\n--dry-run: would send this prompt to `claude -p` and stop here:\n');
    console.log(prompt);
    return;
  }

  if (!existsSync(opts.repoPath)) {
    throw new Error(`NEXT_HARNESS checkout not found at ${opts.repoPath} (set --repo or NEXT_HARNESS_PATH).`);
  }

  warnIfRoot();
  assertCleanCheckout(opts.repoPath, opts.branch);
  runClaudeHeadless(prompt, opts.repoPath, opts.maxBudgetUsd);

  if (!hasNewCommits(opts.repoPath, opts.branch)) {
    throw new Error('claude finished but left no new commits and no uncommitted changes — nothing to push.');
  }

  gitPush(opts.repoPath, opts.branch);

  const { owner, repo } = parseOwnerRepo(opts.repoPath);
  let prUrl = await findOpenPullRequest(owner, repo, opts.branch);
  if (!prUrl) {
    prUrl = await openPullRequest({
      owner,
      repo,
      branch: opts.branch,
      base: opts.base,
      title: 'Fix reliability issues found in harness_agent_runs',
      body: prBody(unresolved),
    });
    console.log(`Opened PR: ${prUrl}`);
  } else {
    console.log(`Pushed to existing PR: ${prUrl}`);
  }

  const remediatedAt = new Date().toISOString();
  for (const finding of unresolved) {
    ledger[finding.signature] = { prUrl, remediatedAt };
  }
  saveLedger(ledger);
  console.log(`Ledger updated with ${unresolved.length} finding(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
