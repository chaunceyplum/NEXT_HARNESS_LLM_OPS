/**
 * `npm run remediate` — the actual change-and-PR step of the pipeline.
 *
 * It acts on two kinds of work item, both flowing through the same
 * agent -> commit -> push -> PR -> ledger machinery:
 *   1. Failure findings   — auto-diagnosed from harness_agent_runs (reactive).
 *   2. Optimizations      — a hand-curated backlog under optimizations/ that
 *                           describes improvements to build (proactive).
 *
 * Steps:
 * 1. Load new/unresolved findings (live from harness_agent_runs by default,
 *    or from a pre-fetched JSON file via --seed) and pending optimizations.
 * 2. If there are any, drive a coding agent against a local target-repo
 *    checkout with all of them as its task — it investigates, changes, adds
 *    tests, and commits locally. It does NOT push or open the PR itself; this
 *    script owns that so it's deterministic.
 *
 *    By default this uses the SELF-CONTAINED in-process engine
 *    (lib/remediation-engine.ts), which talks directly to the Anthropic API
 *    and needs only an ANTHROPIC_API_KEY — no external CLI to install. Pass
 *    `--engine claude-cli` (or REMEDIATE_ENGINE=claude-cli) to instead shell
 *    out to a `claude -p` process, for hosts that prefer it.
 * 3. Push the branch and open (or reuse) a pull request via the GitHub REST API.
 * 4. Optionally merge the PR (--auto-merge / REMEDIATE_AUTO_MERGE=1). Off by
 *    default: this pipeline opens PRs for review; merging is opt-in.
 * 5. Record every shipped work-item signature -> PR url in remediation-ledger.json.
 *
 * Needs git, a GITHUB_TOKEN with push/PR rights (and merge rights for
 * --auto-merge), and either an ANTHROPIC_API_KEY (default engine) or `claude`
 * on PATH (--engine claude-cli).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { loadEnvLocal } from '../lib/load-env';

loadEnvLocal();

import { loadConfig } from '../lib/config';
import {
  buildFindings,
  loadLedger,
  newFindings,
  saveLedger,
  type Finding,
} from '../lib/diagnose';
import {
  loadOptimizations,
  optimizationSignature,
  pendingOptimizations,
  type Optimization,
} from '../lib/optimizations';
import { fetchFailedRuns, type FailedRun } from '../lib/runs-repository';
import { runRemediationEngine } from '../lib/remediation-engine';

type Engine = 'in-process' | 'claude-cli';

interface Options {
  seedPath?: string;
  repoPath: string;
  branch: string;
  base: string;
  optimizationsDir: string;
  maxBudgetUsd: string;
  dryRun: boolean;
  autoMerge: boolean;
  mergeMethod: 'squash' | 'merge' | 'rebase';
  engine: Engine;
}

/** A unit of work handed to the agent — either a diagnosed failure or a backlog optimization. */
interface WorkItem {
  signature: string;
  summary: string;
}

function parseArgs(argv: string[]): Options {
  const config = loadConfig();
  const opts: Options = {
    repoPath: config.repoPath,
    branch: config.branch,
    base: config.base,
    optimizationsDir: config.optimizationsDir,
    maxBudgetUsd: config.maxBudgetUsd,
    dryRun: false,
    autoMerge: process.env.REMEDIATE_AUTO_MERGE === '1',
    mergeMethod: (process.env.REMEDIATE_MERGE_METHOD as Options['mergeMethod']) || 'squash',
    engine: (process.env.REMEDIATE_ENGINE as Engine) || 'in-process',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--seed') opts.seedPath = argv[++i];
    else if (arg === '--repo') opts.repoPath = argv[++i];
    else if (arg === '--branch') opts.branch = argv[++i];
    else if (arg === '--base') opts.base = argv[++i];
    else if (arg === '--optimizations') opts.optimizationsDir = argv[++i];
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--auto-merge') opts.autoMerge = true;
    else if (arg === '--merge-method') opts.mergeMethod = argv[++i] as Options['mergeMethod'];
    else if (arg === '--engine') opts.engine = argv[++i] as Engine;
  }
  return opts;
}

async function loadFailedRuns(opts: Options): Promise<FailedRun[]> {
  if (opts.seedPath) {
    return JSON.parse(readFileSync(opts.seedPath, 'utf-8')) as FailedRun[];
  }
  return fetchFailedRuns();
}

function findingSection(f: Finding): string {
  return [
    `### ${f.signature}`,
    `- Model: ${f.model}`,
    `- Category: ${f.category}`,
    `- Occurrences: ${f.count} (first seen ${f.firstSeen}, last seen ${f.lastSeen})`,
    `- Sample errors:`,
    ...f.sampleErrors.map((e) => `  - ${e}`),
    `- Suggested fix direction: ${f.suggestedFix}`,
  ].join('\n');
}

function optimizationSection(o: Optimization): string {
  return [
    `### ${optimizationSignature(o)} — ${o.title}`,
    `- Priority: ${o.priority}`,
    `- Rationale: ${o.rationale}`,
    ...(o.details ? [`- Implementation guidance: ${o.details}`] : []),
  ].join('\n');
}

function buildPrompt(findings: Finding[], optimizations: Optimization[]): string {
  const lines: string[] = [
    'You are improving the reliability and capability of this repo (the target agent app). Some work items ' +
      'below are failure patterns diagnosed from the app\'s own execution history table (harness_agent_runs); ' +
      'others are proactive optimizations from a curated backlog. All are real, intended changes — not hypotheticals.',
    '',
  ];

  if (findings.length > 0) {
    lines.push('## Failure findings to fix', '');
    for (const f of findings) lines.push(findingSection(f), '');
  }
  if (optimizations.length > 0) {
    lines.push('## Optimizations to implement', '');
    for (const o of optimizations) lines.push(optimizationSection(o), '');
  }

  lines.push(
    'Instructions:',
    '- Investigate the actual code before changing anything — do not apply a suggested direction blindly if the ' +
      'real cause or best approach turns out to be different once you look.',
    '- Several failure findings may share one root cause or fix (e.g. multiple provider-error findings across ' +
      'different models may all be addressed by the same model-health/fallback mechanism) — address the ' +
      'underlying causes with the minimum set of changes, not one patch per finding.',
    '- Where a finding is really an account/infrastructure problem no code change can fix (e.g. missing cloud ' +
      'provider model access), say so in a doc update rather than inventing a code workaround.',
    '- For optimizations, implement the described change scoped to its rationale; if it turns out to be a bad ' +
      'idea once you see the code, leave a note explaining why rather than forcing it.',
    '- Add or update tests covering each change, matching this repo\'s existing conventions.',
    '- Run this repo\'s lint and test commands and fix any failures before you finish.',
    '- Commit your changes with clear, descriptive messages (you may make more than one commit).',
    '- Do not push and do not open a pull request yourself — the calling script handles that after you finish.',
    '- Stay scoped to these work items. Do not refactor or fix unrelated things you notice along the way.'
  );

  return lines.join('\n');
}

// Tools the external `claude` CLI (the --engine claude-cli fallback) is
// granted. Deliberately an allowlist (`--allowed-tools`) rather than
// `--permission-mode bypassPermissions`/`--dangerously-skip-permissions`:
// those disable the whole permission system, which Claude Code refuses to do
// for a process running as root (a real safeguard, not something to work
// around).
const REQUIRED_TOOLS = 'Read Edit Write Glob Grep Bash';

function runClaudeCli(prompt: string, cwd: string, maxBudgetUsd: string): void {
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

/**
 * Drive the selected coding agent against the target checkout. The default
 * in-process engine (lib/remediation-engine.ts) needs only an
 * ANTHROPIC_API_KEY and no external binary — it is what makes autonomous
 * end-to-end runs actually possible. `--engine claude-cli` keeps the original
 * subprocess path for hosts that prefer it.
 */
async function runAgent(prompt: string, opts: Options): Promise<void> {
  if (opts.engine === 'claude-cli') {
    console.log('Engine: claude-cli (external subprocess).');
    runClaudeCli(prompt, opts.repoPath, opts.maxBudgetUsd);
    return;
  }
  console.log('Engine: in-process (Anthropic API, no external CLI).');
  const result = await runRemediationEngine({ repoPath: opts.repoPath, prompt });
  console.log(`Engine finished in ${result.steps} step(s); wrote ${result.filesWritten.length} file(s).`);
  if (result.finalText) console.log(`\nEngine summary:\n${result.finalText}\n`);
}

/** The in-process engine runs fine as root; only the claude-cli fallback trips Claude Code's root safeguards. */
function warnIfRoot(engine: Engine): void {
  if (engine === 'claude-cli' && typeof process.getuid === 'function' && process.getuid() === 0) {
    console.warn(
      'Warning: running the claude-cli engine as root (uid 0) — some Claude Code permission modes are refused ' +
        'outright for root processes (see docs/RUNBOOK.md). The default in-process engine has no such restriction.'
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

interface PullRequest {
  number: number;
  html_url: string;
}

async function findOpenPullRequest(owner: string, repo: string, branch: string): Promise<PullRequest | null> {
  const response = await githubRequest(`/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`);
  if (!response.ok) return null;
  const data = (await response.json()) as PullRequest[];
  return data[0] ?? null;
}

async function openPullRequest(opts: {
  owner: string;
  repo: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}): Promise<PullRequest> {
  const response = await githubRequest(`/repos/${opts.owner}/${opts.repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title: opts.title, head: opts.branch, base: opts.base, body: opts.body }),
  });
  if (!response.ok) {
    throw new Error(`Failed to open PR: HTTP ${response.status} ${await response.text().catch(() => '')}`);
  }
  return (await response.json()) as PullRequest;
}

async function mergePullRequest(
  owner: string,
  repo: string,
  prNumber: number,
  method: Options['mergeMethod']
): Promise<void> {
  const response = await githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
    method: 'PUT',
    body: JSON.stringify({ merge_method: method }),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to merge PR #${prNumber}: HTTP ${response.status} ${await response.text().catch(() => '')} ` +
        `(branch protection, required checks, or conflicts can block auto-merge — the PR is still open for manual merge).`
    );
  }
}

function prBody(findings: Finding[], optimizations: Optimization[]): string {
  const lines = [
    'Opened by NEXT_HARNESS_LLM_OPS (`scripts/remediate.ts`) from work items diagnosed against the live ' +
      '`harness_agent_runs` table and/or the optimization backlog.',
    '',
  ];
  if (findings.length > 0) {
    lines.push('Failure findings addressed:', '');
    for (const f of findings) {
      lines.push(`- \`${f.signature}\` — ${f.count} occurrence(s), ${f.firstSeen} to ${f.lastSeen}`);
    }
    lines.push('');
  }
  if (optimizations.length > 0) {
    lines.push('Optimizations implemented:', '');
    for (const o of optimizations) lines.push(`- \`${optimizationSignature(o)}\` — ${o.title}`);
    lines.push('');
  }
  lines.push('---', '_Generated by [Claude Code](https://claude.ai/code)_');
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const ledger = loadLedger();

  const failedRuns = await loadFailedRuns(opts);
  const findings = buildFindings(failedRuns);
  const unresolvedFindings = newFindings(findings, ledger);

  const optimizations = loadOptimizations(opts.optimizationsDir);
  const pendingOpts = pendingOptimizations(optimizations, ledger);

  const workItems: WorkItem[] = [
    ...unresolvedFindings.map((f) => ({ signature: f.signature, summary: `${f.signature} (${f.count} occurrences)` })),
    ...pendingOpts.map((o) => ({ signature: optimizationSignature(o), summary: `${optimizationSignature(o)} — ${o.title}` })),
  ];

  if (workItems.length === 0) {
    console.log('No new findings or pending optimizations to act on.');
    return;
  }

  console.log(`${workItems.length} work item(s) to act on:`);
  for (const w of workItems) console.log(`  - ${w.summary}`);

  const prompt = buildPrompt(unresolvedFindings, pendingOpts);

  if (opts.dryRun) {
    console.log(`\n--dry-run: would drive the "${opts.engine}" engine with this prompt and stop here:\n`);
    console.log(prompt);
    return;
  }

  if (!existsSync(opts.repoPath)) {
    throw new Error(`Target repo checkout not found at ${opts.repoPath} (set --repo or NEXT_HARNESS_PATH).`);
  }

  warnIfRoot(opts.engine);
  assertCleanCheckout(opts.repoPath, opts.branch);
  await runAgent(prompt, opts);

  if (!hasNewCommits(opts.repoPath, opts.branch)) {
    throw new Error('The coding agent finished but left no new commits and no uncommitted changes — nothing to push.');
  }

  gitPush(opts.repoPath, opts.branch);

  const { owner, repo } = parseOwnerRepo(opts.repoPath);
  let pr = await findOpenPullRequest(owner, repo, opts.branch);
  if (!pr) {
    pr = await openPullRequest({
      owner,
      repo,
      branch: opts.branch,
      base: opts.base,
      title: 'LLM-Ops: fix reliability findings and implement backlog optimizations',
      body: prBody(unresolvedFindings, pendingOpts),
    });
    console.log(`Opened PR #${pr.number}: ${pr.html_url}`);
  } else {
    console.log(`Pushed to existing PR #${pr.number}: ${pr.html_url}`);
  }

  if (opts.autoMerge) {
    await mergePullRequest(owner, repo, pr.number, opts.mergeMethod);
    console.log(`Merged PR #${pr.number} (${opts.mergeMethod}).`);
  }

  const remediatedAt = new Date().toISOString();
  for (const item of workItems) {
    ledger[item.signature] = { prUrl: pr.html_url, remediatedAt };
  }
  saveLedger(ledger);
  console.log(`Ledger updated with ${workItems.length} work item(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
