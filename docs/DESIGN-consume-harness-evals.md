# Design: consume NEXT_HARNESS eval data in LLM_OPS

Status: proposed
Author: LLM-Ops architecture
Target repo: `NEXT_HARNESS_LLM_OPS` (this repo)
Reads from (read-only): `NEXT_HARNESS` eval tables + `NEXT_HARNESS/evals/baseline.json`

## 1. Problem statement

Today the LLM-Ops pipeline ingests exactly one NEXT_HARNESS data source: the
`harness_agent_runs` table (production run history), read through the MCP
`execute_sql` bridge in `lib/runs-repository.ts`. It classifies provider/infra
errors (`lib/error-classification.ts`), groups them into findings
(`lib/diagnose.ts`), tracks remediation in `remediation-ledger.json`, reports
with `scripts/report.ts`, and dispatches fixes as PRs via `scripts/remediate.ts`
plus `lib/remediation-engine.ts`.

NEXT_HARNESS also runs a full **eval system** whose results land in the SAME
Postgres (reachable through the SAME MCP `execute_sql` bridge), in two tables
defined in `NEXT_HARNESS/lib/eval-store.ts`:

- `harness_eval_runs` — one row per eval invocation, with a `metrics` JSONB
  column (`EvalRunMetrics`, defined in `NEXT_HARNESS/lib/eval-metrics.ts`).
- `harness_eval_results` — one row per fixture trial.

The eval system also commits a **regression floor** at
`NEXT_HARNESS/evals/baseline.json`: per-suite thresholds for success rate,
all-trials-pass reliability (`passHatK`), and a safety-violation ceiling.

**LLM_OPS does not read any of this today.** That means a quality regression a
nightly eval would catch (success rate falling below floor, reliability
dropping, or a safety violation appearing) is invisible to the
diagnose→remediate→PR machinery that already exists for runtime failures. The
pipeline reacts to crashes but is blind to *quality* and *safety* regressions
even though the data sits in the same database it already queries.

### Goal

Add eval data as a **third input source** to the existing
findings→ledger→remediate pipeline, mirroring how the proactive
`optimizations/*.json` backlog was added as a second source. When a suite's
latest eval run breaches its committed baseline threshold (or shows any safety
violation), emit an **eval finding** that flows through the same
agent→commit→push→PR→ledger machinery, with PR-only remediation (never
auto-merge).

### Non-goals (first cut)

- No rolling/historical baseline drift detection (compare only against the
  committed `baseline.json` for now; see Decision 2).
- No auto-merge of eval remediations (see Decision 3).
- No coverage of the `routing` suite or non-floor metrics (cost, latency,
  tokens) as *gating* findings in the first cut (see Decision 1); they can be
  surfaced informationally and promoted later.
- No writes to any NEXT_HARNESS eval table — strictly read-only, exactly like
  `runs-repository.ts`.

## 2. Current-state analysis (concrete references)

- `lib/mcp-client.ts` — `callMcpTool(toolName, args)`; JSON-RPC `tools/call`
  over `fetch` to `MCP_ENDPOINT_URL`; `unwrapToolResult` unwraps
  `{ content: [{ type: 'text', text: '<json>' }] }` into the parsed payload.
  No DB credentials in this repo by design.
- `lib/sql.ts` — `sqlStr(value)` and `sqlTimestamp(date)`. **Critical gotcha:
  `execute_sql` has NO parameter binding; every interpolated value must be
  escaped by hand through these helpers.** New table names come from config,
  not user input, and are interpolated unquoted (identifiers), exactly as
  `runs-repository.ts` already does with `runsTable`.
- `lib/runs-repository.ts` — the ingestion template: `execSql(sql)` wraps
  `callMcpTool('execute_sql', { sql })` and returns `{ rows?: [...] }`; row
  objects are mapped to typed interfaces (`FailedRun`, `RunTotals`). The table
  name is read once from `loadConfig().runsTable`.
- `lib/config.ts` — `TargetConfig`, env-driven with NEXT_HARNESS-shaped
  defaults. `runsTable` ← `HARNESS_RUNS_TABLE`; `repoPath` ← `NEXT_HARNESS_PATH`
  (default `../NEXT_HARNESS`, the local checkout used to read repo files like
  `evals/baseline.json`). This is where new eval config is added.
- `lib/diagnose.ts` — defines `Finding`, `Ledger`, `LedgerEntry`,
  `findingSignature(model, category)` → `"<model>::<category>"`,
  `buildFindings`, `loadLedger`/`saveLedger`, and `newFindings` (recurrence:
  a finding whose `lastSeen > ledger entry.remediatedAt` is treated as new
  again). The `Ledger` type and `newFindings` recurrence semantics are reused
  for eval findings unchanged.
- `lib/optimizations.ts` — the template for a **second** input source:
  `optimizationSignature({id})` → `"opt::<id>"`, zod-validated JSON loading,
  `pendingOptimizations(opts, ledger)` filters out already-shipped signatures.
  Note: optimizations never "recur"; eval findings DO (via `newFindings`),
  because a regression that reappears after a fix means the fix did not hold.
- `scripts/report.ts` — read-only markdown report; builds findings + pending
  optimizations and prints a table + unresolved sections. New: an
  "Eval regressions" section.
- `scripts/remediate.ts` — the work-item loop. `WorkItem { signature, summary }`;
  it concatenates `unresolvedFindings` + `pendingOpts` into `workItems`, builds
  one agent prompt, drives the engine, pushes, opens/updates a PR, and records
  each signature in the ledger. New: eval findings become a third work-item
  stream, feeding the SAME loop. The engine (`lib/remediation-engine.ts`) does
  not change.

### What the eval data looks like (read from NEXT_HARNESS, do not import)

LLM_OPS has no `@/lib` access to NEXT_HARNESS, so the shapes below are mirrored
as small LOCAL interfaces in LLM_OPS (never imported from the sibling repo).

`harness_eval_runs` columns:
`id TEXT PK, suite TEXT, subject TEXT, judge_model TEXT, passed_count INT,
total_count INT, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
trials_per_fixture INT DEFAULT 1, prompt_version TEXT, metrics JSONB`.

`harness_eval_results` columns:
`eval_run_id TEXT (FK), fixture_id TEXT, passed BOOLEAN, notes TEXT,
duration_ms INT, total_tokens INT, trial INT DEFAULT 1, category TEXT,
structural_passed BOOLEAN, safety_violation BOOLEAN, cost_usd DOUBLE PRECISION,
steps INT, tool_calls INT, errored BOOLEAN`.

`metrics` JSONB is `EvalRunMetrics`:
`fixtures, trials, errored, k, successRate, passAtK, passHatK,
toolCallAccuracy?, safetyViolationRate, safetyViolations, stepsMean?,
latencyP50Ms?, latencyP95Ms?, totalCostUsd?, costPerSuccessUsd?,
tokensPerSuccess?`.

`EvalSuite = 'agent' | 'tool_shortlist' | 'rag_judge' | 'judge_calibration' | 'routing'`.

`baseline.json` shape (null = not checked; safety ceiling held at 0):
```json
{
  "agent": { "minSuccessRate": null, "minPassHatK": null, "maxSafetyViolationRate": 0 },
  "tool_shortlist": { "minSuccessRate": null },
  "rag_judge": { "minSuccessRate": null },
  "judge_calibration": { "minSuccessRate": null }
}
```

## 3. Proposed architecture

### Data flow

```
            MCP execute_sql bridge                      local NEXT_HARNESS checkout
                     │                                            │
                     ▼                                            ▼
   harness_eval_runs (latest per suite,subject)        evals/baseline.json
   harness_eval_results (failing/unsafe trials)                  │
                     │                                            │
                     ▼                                            │
        lib/evals-repository.ts  ──── EvalRunRow[] ──┐            │
        (read-only, mirrors runs-repository.ts)      │            │
                                                     ▼            ▼
                                        lib/baseline.ts (compare metrics ↔ thresholds)
                                                     │
                                                     ▼  EvalRegression[]
                                        lib/diagnose-evals.ts
                                        (regressions → EvalFinding[],
                                         signature eval::<suite>::<metric>,
                                         reuse Ledger + newFindings)
                                                     │
                        ┌────────────────────────────┴───────────────────────┐
                        ▼                                                      ▼
                scripts/report.ts                                     scripts/remediate.ts
                (new "Eval regressions" section)             (eval findings as a 3rd work-item
                                                              stream → same engine → commit →
                                                              push → PR → ledger; PR-only)
```

### New modules and signatures

#### `lib/evals-repository.ts` (new, read-only)

Mirrors `runs-repository.ts`: `execSql` wraps `callMcpTool('execute_sql', { sql })`;
table names come from config; all interpolated values escaped via `lib/sql.ts`.

```ts
export interface EvalRunMetrics {        // LOCAL mirror of NEXT_HARNESS's shape
  fixtures: number; trials: number; errored: number; k: number;
  successRate: number; passAtK: number; passHatK: number;
  toolCallAccuracy?: number;
  safetyViolationRate: number; safetyViolations: number;
  stepsMean?: number; latencyP50Ms?: number; latencyP95Ms?: number;
  totalCostUsd?: number; costPerSuccessUsd?: number; tokensPerSuccess?: number;
}

export interface EvalRunRow {
  id: string; suite: string; subject: string;
  judgeModel?: string; promptVersion?: string;
  passedCount: number; totalCount: number; trialsPerFixture: number;
  startedAt: string; finishedAt: string;
  metrics?: EvalRunMetrics;              // parsed from the metrics JSONB column
}

export interface EvalFailingTrial {
  evalRunId: string; fixtureId: string; trial: number;
  category?: string; notes: string;
  safetyViolation?: boolean; structuralPassed?: boolean;
}

/** Latest eval run per (suite, subject), newest finished_at wins. */
export function fetchLatestEvalRuns(opts?: { suites?: string[] }): Promise<EvalRunRow[]>;

/** Failing or safety-violating trials for the given run ids (sample evidence). */
export function fetchFailingTrials(evalRunIds: string[], opts?: { limit?: number }): Promise<EvalFailingTrial[]>;
```

Latest-per-group SQL uses a `DISTINCT ON (suite, subject) ... ORDER BY suite,
subject, finished_at DESC` select (Postgres), restricted by suite when
`opts.suites` is given (each suite string escaped via `sqlStr`). The `metrics`
JSONB arrives already-parsed (object) through the MCP bridge; the mapper
tolerates either an object or a JSON string and leaves `metrics` undefined when
null. `fetchFailingTrials` returns `[]` for an empty id list without issuing SQL.

#### `lib/baseline.ts` (new)

```ts
export interface SuiteThresholds {
  minSuccessRate?: number | null;
  minPassHatK?: number | null;
  maxSafetyViolationRate?: number | null;
}
export type Baseline = Record<string, SuiteThresholds>;

export interface EvalRegression {
  suite: string;
  subject: string;
  metric: 'successRate' | 'passHatK' | 'safetyViolationRate';
  observed: number;
  threshold: number;         // the floor/ceiling that was breached
  direction: 'below' | 'above';
  evalRunId: string;
  finishedAt: string;
}

/** Read ${repoPath}/evals/baseline.json. Returns {} if absent. Throws on malformed JSON. */
export function loadBaseline(repoPath: string): Baseline;

/** Compare one run's metrics to its suite thresholds; honor null = skip; always flag safetyViolationRate > 0. */
export function findRegressions(runs: EvalRunRow[], baseline: Baseline): EvalRegression[];
```

Comparison rules:
- `minSuccessRate` / `minPassHatK`: breached when `observed < threshold`.
  A `null`/absent threshold is NOT checked.
- `maxSafetyViolationRate`: breached when `observed > threshold`. Convention:
  the safety ceiling is held at `0`, so any `safetyViolationRate > 0` is a
  regression. If a suite omits `maxSafetyViolationRate`, treat the ceiling as
  `0` for the agent suite (safety is non-negotiable from day one); for other
  suites, an absent safety ceiling is not checked. (Captured as behavior in
  tests.)
- A run with no `metrics` object is skipped (can't compare) and logged.

#### `lib/diagnose-evals.ts` (new)

```ts
export interface EvalFinding {
  signature: string;        // eval::<suite>::<metric>
  suite: string;
  subject: string;
  metric: EvalRegression['metric'];
  observed: number;
  threshold: number;
  count: number;            // regressions collapsed into this signature
  firstSeen: string;        // earliest finishedAt
  lastSeen: string;         // latest finishedAt (drives newFindings recurrence)
  sampleErrors: string[];   // failing/unsafe fixture notes, capped at 3
  suggestedFix: string;     // metric-specific guidance
}

export function evalFindingSignature(suite: string, metric: string): string; // `eval::${suite}::${metric}`

export function buildEvalFindings(
  regressions: EvalRegression[],
  trialsByRun: Map<string, EvalFailingTrial[]>
): EvalFinding[];

// Reuse Ledger + newFindings from lib/diagnose.ts for recurrence filtering.
```

`buildEvalFindings` groups regressions by `eval::<suite>::<metric>` (so the same
metric breaching across subjects collapses into one finding), fills
`sampleErrors` from the failing-trial notes of the referenced runs (safety
violations first, capped at 3 distinct messages, matching `buildFindings`'
3-sample convention), and sets a metric-specific `suggestedFix`:
- `successRate` → quality regression; investigate recent prompt/model/tool
  changes for this suite+subject; compare failing fixture notes.
- `passHatK` → reliability/flakiness regression; some fixtures pass only
  sometimes across k trials; look for nondeterminism (sampling temperature,
  tool-order variance).
- `safetyViolationRate` → **safety regression**; the agent followed an unsafe
  instruction in at least one trial; treat as highest priority; inspect the
  flagged fixtures' notes.

Recurrence: eval findings are filtered through the existing
`newFindings(findings, ledger)` (same `signature` + `lastSeen` contract), so a
regression that reappears after a fix landed is re-raised.

### Config additions (`lib/config.ts`)

```ts
evalRunsTable: process.env.HARNESS_EVAL_RUNS_TABLE || 'harness_eval_runs',
evalResultsTable: process.env.HARNESS_EVAL_RESULTS_TABLE || 'harness_eval_results',
baselinePath: process.env.HARNESS_EVAL_BASELINE_PATH || 'evals/baseline.json', // relative to repoPath
evalSuites: (process.env.HARNESS_EVAL_SUITES || 'agent').split(',').map(s => s.trim()).filter(Boolean),
```

`evalSuites` defaults to `['agent']` to implement Decision 1 (agent suite
first). `baselinePath` is resolved against `repoPath` so it reads the local
NEXT_HARNESS checkout, exactly how remediation already uses `repoPath`.

### Ledger / signature scheme

A third signature namespace joins the two existing ones:
- Failure findings: `<model>::<category>` (e.g. `bedrock:balanced::provider_access`)
- Optimizations: `opt::<id>`
- **Eval findings: `eval::<suite>::<metric>`** (e.g. `eval::agent::safetyViolationRate`)

The `eval::` prefix guarantees no collision with the other two namespaces. Eval
findings use the SAME `remediation-ledger.json` and the SAME `LedgerEntry`
`{ prUrl, remediatedAt }` shape. Recurrence works via `newFindings`: an eval
finding whose `lastSeen` (latest run `finishedAt`) is after its ledger
`remediatedAt` is re-raised — i.e. the regression came back after the fix, so
the fix did not hold.

### Remediation posture

Eval findings are **PR-only** (Decision 3). They flow through the identical
`scripts/remediate.ts` loop as a third work-item stream and are recorded in the
ledger on PR open, but the pipeline never auto-merges them even when
`--auto-merge` is passed for other work items in the first cut. Rationale:
quality/safety fixes carry more behavioral risk than config fixes, so a human
reviews them. (Implementation: eval work items are added to the same prompt and
ledger write, but if any eval finding is in the batch the script does not call
`mergePullRequest` for that PR; documented and covered by the design, with the
simplest safe default being "eval findings open a PR and stop".)

## 4. Phased rollout

1. **Phase 1 — ingestion.** `lib/evals-repository.ts` + config additions. Pure
   read path; no behavior change to existing commands yet.
2. **Phase 2 — baseline comparison.** `lib/baseline.ts`: load baseline from the
   local checkout, compare metrics honoring null-skip and the safety ceiling.
3. **Phase 3 — diagnosis.** `lib/diagnose-evals.ts`: regressions → eval findings
   with signatures, sample evidence, and metric-specific suggested fixes;
   reuse `Ledger`/`newFindings`.
4. **Phase 4 — wiring.** New "Eval regressions" section in `scripts/report.ts`;
   eval findings as a third work-item stream in `scripts/remediate.ts`
   (PR-only). Engine untouched.
5. **Phase 5 — tests + docs.** Vitest unit tests (baseline incl. null-skip and
   safety ceiling; diagnose-evals grouping/signatures/recurrence;
   evals-repository SQL escaping with a mocked `callMcpTool`). Update
   `README.md` ("two kinds of work item" → three) and `docs/RUNBOOK.md`.

Phases 1–5 are delivered together in this change (coherent single unit), but
the module boundaries above keep each phase independently reviewable.

## 5. Data models

See the interfaces in Section 3. All eval shapes are LOCAL mirrors; nothing is
imported from NEXT_HARNESS. The only cross-repo coupling is (a) the SQL column
names of the two eval tables and (b) the `baseline.json` schema — both read
defensively (tolerant mappers, null-skip thresholds).

## 6. Test plan

Vitest, matching existing `*.test.ts` style (`mkdtempSync` temp dirs for
file-based tests; `vi.fn()`/injected deps for the SQL path). No live DB/network.

- `lib/baseline.test.ts`
  - `loadBaseline` returns `{}` when the file is absent; throws on malformed JSON.
  - `findRegressions`: flags `successRate`/`passHatK` below floor; does NOT flag
    when the threshold is `null`; flags any `safetyViolationRate > 0`; does NOT
    flag `safetyViolationRate === 0`; skips runs with no metrics.
  - A metric exactly equal to its floor is NOT a regression (boundary).
- `lib/diagnose-evals.test.ts`
  - `evalFindingSignature` → `eval::<suite>::<metric>`, distinct namespace.
  - groups multiple subjects' regressions of the same metric into one finding
    with summed `count` and correct first/last seen.
  - `sampleErrors` populated from failing-trial notes, safety-first, capped at 3.
  - `newFindings` (reused) excludes an eval finding remediated after `lastSeen`
    and re-includes one that recurred after `remediatedAt`.
- `lib/evals-repository.test.ts`
  - mocked `callMcpTool`: asserts the generated SQL escapes suite names via
    `sqlStr` (inject a suite like `o'brien` and assert the doubled quote); maps
    rows (incl. metrics as object AND as JSON string) to `EvalRunRow`;
    `fetchFailingTrials([])` returns `[]` without calling the bridge.

Validation gates (no DB available here): `npm run typecheck` and `npm test`.

## 7. Risks and gotchas

- **No SQL parameter binding.** Every interpolated value MUST go through
  `lib/sql.ts`. Table names come from config (trusted), interpolated as bare
  identifiers like the existing repo does; suite filters are user-influenced and
  MUST be `sqlStr`-escaped.
- **`metrics` JSONB shape drift.** NEXT_HARNESS owns `EvalRunMetrics`; our local
  mirror can fall behind. Mitigation: read defensively (all optional fields
  optional; unknown fields ignored), and only *gate* on the three baseline
  metrics.
- **Runs without metrics.** Older rows can have `metrics = NULL`. Skip them for
  comparison (logged), never crash.
- **`null` threshold = skip, not zero.** Easy to get backwards; explicitly
  tested. The safety ceiling is the one metric defaulted to `0`.
- **Latest-run selection.** `DISTINCT ON` relies on `finished_at`; ties are
  unlikely but resolved by ordering. We compare only the single latest run per
  (suite, subject), matching the nightly-gate mental model.
- **Recurrence vs. optimizations.** Unlike optimizations (never recur), eval
  findings reuse `newFindings`, so they correctly re-raise if a regression
  returns after a fix.
- **Env not available here.** `MCP_ENDPOINT_URL` and provider keys are absent in
  this environment, so the live pipeline can't run; correctness is proven by
  `typecheck` + mocked-bridge unit tests.

## 8. Open design decisions (with recommended defaults — implemented)

1. **First-cut scope.** Start with the `agent` suite + safety/success/reliability
   metrics (highest value, matches the thresholds actually present in
   `baseline.json`); widen to other suites and informational metrics later.
   *Recommended and implemented* via `evalSuites` defaulting to `['agent']`.
2. **Threshold source of truth.** Compare against the committed `baseline.json`
   now; add rolling historical-baseline drift detection later. *Recommended and
   implemented* — `baseline.ts` reads the committed file only.
3. **Remediation posture.** Eval findings are PR-only (never auto-merged)
   initially, since quality/safety fixes are riskier than config fixes.
   *Recommended and implemented* — eval work items open a PR and are recorded in
   the ledger, but are excluded from auto-merge.

## 9. Backlog spec

A companion optimization backlog item is committed at
`optimizations/0002-consume-harness-evals.json` (schema: `lib/optimizations.ts`),
capturing this work as a tracked, ledgered item so the pipeline records it as
shipped once merged.
