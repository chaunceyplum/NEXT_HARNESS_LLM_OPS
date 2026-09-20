# NEXT_HARNESS_LLM_OPS

A diagnosis-and-remediation pipeline for [NEXT_HARNESS](../NEXT_HARNESS) — it
reads the harness's own execution history, groups failures into systemic
findings, and dispatches fixes into NEXT_HARNESS as pull requests. It is not
a passive dashboard: its job is to turn "the table shows a bunch of errors"
into "here's a PR that fixes the root cause."

## Why this exists

NEXT_HARNESS persists every `/api/build` run (success or failure) to a
`harness_agent_runs` table in the MCP server's own Postgres instance (see
`NEXT_HARNESS/lib/execution-store.ts` and `NEXT_HARNESS/ARCHITECTURE.md`).
Nobody was looking at it. A first pass over the live table (Aug/Sep 2026)
found 39 of 88 runs (44%) had failed, and *every one* of those failures was
an LLM-provider configuration/access error (Bedrock model access not
granted, a missing/invalid Anthropic API key, low account balance) or a
context-length overflow — never a tool-call or agent-logic bug. That's the
kind of thing that should be caught and fixed automatically, not discovered
by someone running ad hoc SQL.

## How it works

1. **Read** — `lib/runs-repository.ts` queries `harness_agent_runs` through
   the same MCP `execute_sql` tool NEXT_HARNESS already uses to write to it
   (`lib/mcp-client.ts` here is the same JSON-RPC bridge pattern as
   `NEXT_HARNESS/lib/mcp-client.ts`, same `MCP_ENDPOINT_URL`). This pipeline
   never gets its own database credentials — the MCP server is the only
   thing with real credentials, by design (see
   `NEXT_HARNESS/ARCHITECTURE.md`).
2. **Classify** — `lib/error-classification.ts` buckets each failure's error
   message into a category (`provider_auth`, `provider_access`,
   `provider_quota`, `context_length`, `tool_failure`, `unknown`).
3. **Diagnose** — `lib/diagnose.ts` groups classified failures into stable
   *findings* (one per `model` + `category` signature, with counts and
   sample errors), and checks `remediation-ledger.json` to see which
   findings already have a fix PR filed, so the same issue isn't re-reported
   forever.
4. **Report** — `npm run report` prints the current findings, pending
   optimizations, and ledger status as markdown. Run it any time to see the
   health picture.
5. **Remediate** — for each new/unremediated finding *and* each pending
   optimization (see below), a coding agent is driven against the
   NEXT_HARNESS repo with the work item as its task: make the change, open a
   PR, and update the ledger with the PR link. By default it opens PRs for
   review and stops there; auto-merge is opt-in (`--auto-merge`). This step is
   dispatched by whatever runs the pipeline — a human-driven session, or the
   scheduled GitHub Actions workflow (see below).

## The remediation engine (autonomous, no external CLI)

The fix step runs a **self-contained, in-process engine**
(`lib/remediation-engine.ts`): an agentic tool-use loop that talks directly to
the Anthropic API and edits a local NEXT_HARNESS checkout through a small,
sandboxed tool set (read/write files, list dirs, run the repo's own
tests/lint/git — all confined to the repo root). It needs only an
`ANTHROPIC_API_KEY` — **no external `claude` CLI to install**, which is what
lets it run fully autonomously in CI or on any host.

Engine selection:

- `--engine in-process` (default) — the built-in engine described above.
- `--engine claude-cli` — shell out to a `claude -p` subprocess instead, for
  hosts that prefer it. (`REMEDIATE_ENGINE` sets the default.)

The engine only edits and commits; pushing, opening the PR, and the optional
merge are always owned by `scripts/remediate.ts` so they stay deterministic
and auditable.

## Two kinds of work item

This pipeline acts on two inputs, both flowing through the same
agent → commit → push → PR → ledger machinery:

- **Failure findings** (reactive) — auto-diagnosed from `harness_agent_runs`,
  as described above.
- **Optimizations** (proactive) — a hand-curated backlog under
  `optimizations/`. Each `*.json` file describes an improvement you want made
  to NEXT_HARNESS (a feature, refactor, hardening, telemetry, …). See
  `optimizations/README.md` for the format. This is how the pipeline builds
  *additions*, not just fixes. Once shipped, an optimization's signature
  (`opt::<id>`) is recorded in the ledger so it isn't rebuilt on the next run.

## Merging PRs

By default this pipeline **opens** PRs and leaves merging to a human review.
To let it merge too, pass `--auto-merge` (or set `REMEDIATE_AUTO_MERGE=1`);
the merge method defaults to `squash` and is overridable with
`--merge-method`. Auto-merge still respects the target repo's branch
protection and required checks — if those block it, the PR simply stays open
for manual merge.

## Remediation ledger

`remediation-ledger.json` tracks `signature -> { prUrl, remediatedAt }`.
A finding that recurs *after* its `remediatedAt` timestamp is treated as new
again — that usually means the fix didn't actually address the root cause.

## Running it

```bash
npm install
cp .env.local.example .env.local   # fill in MCP_ENDPOINT_URL
npm run report                                     # read-only health picture
npm run remediate -- --dry-run                     # see the agent prompt, no changes
npm run remediate                                  # fix + open PR(s)
npm run remediate -- --auto-merge                  # …and merge them
```

## Keeping it running

This is meant to run on a recurring schedule, not just once. The simplest
setup is the included **GitHub Actions workflow** (`.github/workflows/llm-ops.yml`):
a scheduled read-only report every 6 hours, plus a gated remediation run you
can trigger manually (or on the same schedule) that opens/merges PRs into
NEXT_HARNESS. It needs a handful of repository secrets — `MCP_ENDPOINT_URL`,
`ANTHROPIC_API_KEY`, and a `GH_PAT` with push/PR rights on NEXT_HARNESS.

If you'd rather run it on a box (EC2, cron) instead of CI, see
`docs/RUNBOOK.md`.
