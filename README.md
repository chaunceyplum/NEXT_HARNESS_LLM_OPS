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
4. **Report** — `npm run report` prints the current findings and ledger
   status as markdown. Run it any time to see the health picture.
5. **Remediate** — for each new/unremediated finding, a Claude coding agent
   is driven against the NEXT_HARNESS repo with the finding as its task: fix
   the root cause, open a PR (never auto-merge — PRs from this pipeline are
   reviewed like any other), and the ledger gets updated with the PR link.
   This step doesn't run inside this repo's own process — it's dispatched by
   whatever is running the pipeline (a human-driven session today; a
   scheduled Claude Code Remote trigger going forward — see below).

## Remediation ledger

`remediation-ledger.json` tracks `signature -> { prUrl, remediatedAt }`.
A finding that recurs *after* its `remediatedAt` timestamp is treated as new
again — that usually means the fix didn't actually address the root cause.

## Running it

```bash
npm install
cp .env.local.example .env.local   # fill in MCP_ENDPOINT_URL
npm run report
```

## Keeping it running

This is meant to run on a recurring schedule, not just once. See
`docs/RUNBOOK.md` for how the recurring Claude Code Remote trigger is set up
and what it does on each fire.
