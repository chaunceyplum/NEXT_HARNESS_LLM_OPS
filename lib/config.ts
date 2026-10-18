/**
 * Central config for the pipeline's target.
 *
 * Everything that used to be hardcoded to NEXT_HARNESS lives here now, read
 * from the environment with NEXT_HARNESS-shaped defaults. That keeps the
 * default behaviour identical to before (this repo's whole reason to exist
 * is optimizing NEXT_HARNESS), while making it possible to point the same
 * pipeline at another agent app — or a differently-named runs table — without
 * editing code in five places.
 */

export interface TargetConfig {
  /** Table in the MCP server's Postgres that stores agent runs. */
  runsTable: string;
  /** Local checkout of the target repo that remediation edits. */
  repoPath: string;
  /** Branch in the target repo that fixes are committed/pushed to. */
  branch: string;
  /** Base branch PRs are opened against. */
  base: string;
  /** Directory holding the proactive optimization backlog (see lib/optimizations.ts). */
  optimizationsDir: string;
  /** Budget ceiling handed to the headless coding agent, in USD. */
  maxBudgetUsd: string;
  /** Table holding one row per eval invocation (see lib/evals-repository.ts). */
  evalRunsTable: string;
  /** Table holding one row per eval fixture trial. */
  evalResultsTable: string;
  /** Path to the committed regression floor, resolved relative to repoPath. */
  baselinePath: string;
  /** Eval suites to gate on. First cut defaults to just the agent suite. */
  evalSuites: string[];
}

export function loadConfig(): TargetConfig {
  return {
    runsTable: process.env.HARNESS_RUNS_TABLE || 'harness_agent_runs',
    repoPath: process.env.NEXT_HARNESS_PATH || '../NEXT_HARNESS',
    branch: process.env.NEXT_HARNESS_BRANCH || 'claude/llm-ops-pipeline-plan-23aa8s',
    base: process.env.NEXT_HARNESS_BASE_BRANCH || 'main',
    optimizationsDir: process.env.OPTIMIZATIONS_DIR || 'optimizations',
    maxBudgetUsd: process.env.REMEDIATE_MAX_BUDGET_USD || '3',
    evalRunsTable: process.env.HARNESS_EVAL_RUNS_TABLE || 'harness_eval_runs',
    evalResultsTable: process.env.HARNESS_EVAL_RESULTS_TABLE || 'harness_eval_results',
    baselinePath: process.env.HARNESS_EVAL_BASELINE_PATH || 'evals/baseline.json',
    evalSuites: (process.env.HARNESS_EVAL_SUITES || 'agent')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
