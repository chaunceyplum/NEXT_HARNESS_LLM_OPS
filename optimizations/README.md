# Optimization backlog

This directory is the *proactive* half of the pipeline. Where a failure
finding is auto-discovered from `harness_agent_runs`, an optimization is a
change **you** want made to the target repo (NEXT_HARNESS) — a new feature,
a refactor, hardening, telemetry, etc.

Each `*.json` file here is either one optimization object or an array of them.
`npm run remediate` picks up every optimization not yet recorded in
`remediation-ledger.json`, hands it to the same headless coding agent that
handles failure fixes, and opens/updates a PR. Once shipped, the optimization's
signature (`opt::<id>`) lands in the ledger and it won't be attempted again —
so this backlog is safe to leave in place across scheduled runs.

## Format

```json
{
  "id": "unique-slug",             // stable; becomes the ledger signature `opt::unique-slug`
  "title": "One-line summary",
  "rationale": "Why this is worth doing",
  "details": "Optional implementation guidance / constraints",
  "priority": "high" | "medium" | "low"   // optional, defaults to medium
}
```

## Lifecycle

1. Add a file describing the change you want.
2. `npm run report` shows it under "Pending optimizations".
3. `npm run remediate` (or the scheduled run) builds it and opens a PR.
4. After the PR is recorded in the ledger it's considered done. To request
   further work on the same area, add a **new** id — don't reuse a shipped one.
