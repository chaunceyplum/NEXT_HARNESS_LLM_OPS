# Brief: Next steps for eval consumption

**Status:** [PR #3](https://github.com/chaunceyplum/NEXT_HARNESS_LLM_OPS/pull/3)
shipped the first cut — LLM_OPS now reads NEXT_HARNESS eval history
(`harness_eval_runs` / `harness_eval_results`) and the committed
`evals/baseline.json`, turns baseline breaches and safety violations into
`eval::<suite>::<metric>` findings, and flows them through the existing
diagnose → ledger → remediate → PR loop (PR-only).

This brief captures what to do next. It is deliberately scoped to the items the
[design doc](./DESIGN-consume-harness-evals.md) explicitly deferred (its
"Non-goals" and "Open design decisions" sections), plus the validation gap that
exists because no live environment was available during the first cut.

---

## 0. Validate against a live pipeline (do this first)

Everything in the first cut was proven by `npm run typecheck` + mocked-bridge
unit tests. It has **never run against a real MCP endpoint or real eval data**
because `MCP_ENDPOINT_URL` and provider credentials were unavailable.

- Set `MCP_ENDPOINT_URL` (and auth) in an environment that can reach the MCP
  server, then run `npm run report` and confirm the new "Eval regressions"
  section renders against real `harness_eval_runs` rows.
- Do a `npm run remediate -- --dry-run` to confirm an eval finding produces a
  sensible agent task prompt before letting it open a PR.
- Confirm the local NEXT_HARNESS checkout path resolves `evals/baseline.json`
  as expected (`HARNESS_EVAL_BASELINE_PATH` / `repoPath`).

**Why first:** this is the only unverified assumption in the shipped code. A
one-time live smoke run de-risks everything built on top of it.

**Effort:** S. **Depends on:** access to a live MCP endpoint.

---

## 1. Widen suite coverage beyond `agent`

The first cut gates only on the `agent` suite (`evalSuites` defaults to
`['agent']`). `tool_shortlist`, `rag_judge`, and `judge_calibration` have
`minSuccessRate` floors in `baseline.json` but are not yet gated; `routing` has
no floor at all.

- Enable the other suites that already have thresholds in `baseline.json` by
  extending the default `evalSuites` once each has a non-null floor set from a
  trusted green run.
- Confirm `diagnose-evals` suggested-fix text is sensible per suite (the
  current fixes are agent-oriented); add suite-specific guidance where the
  generic text is unhelpful.

**Effort:** S–M. **Depends on:** item 0 (validate first). **Watch:** don't gate
a suite whose floor is still `null` — that silently checks nothing.

---

## 2. Surface non-floor metrics (cost / latency / tokens) informationally

`EvalRunMetrics` carries `totalCostUsd`, `costPerSuccessUsd`, `latencyP95Ms`,
`tokensPerSuccess`, `stepsMean`, etc. The first cut gates only on the three
baseline metrics and ignores the rest.

- Add a read-only "trend" line per suite/subject to `npm run report` showing
  these metrics for the latest run (no gating, no findings).
- This builds the observability needed before deciding whether any of them
  should ever become a *gating* finding.

**Effort:** S. **Depends on:** nothing (report-only, safe). **Watch:** keep it
non-gating — these metrics have no agreed thresholds yet.

---

## 3. Rolling / historical baseline drift detection

Today comparison is strictly against the committed `baseline.json` (a single
hand-set floor). A regression that stays *above* the floor but is trending
worse run-over-run is invisible.

- Add an optional second comparison mode that reads the last N
  `harness_eval_runs` for a (suite, subject) and flags statistically meaningful
  drops relative to a rolling window, independent of the committed floor.
- Keep it behind a config flag; the committed-baseline path stays the default
  (Decision 2 in the design doc).

**Effort:** M–L. **Depends on:** item 0, and enough historical rows to be
meaningful. **Watch:** noise — needs a sensible window size and threshold to
avoid flagging normal run-to-run variance.

---

## 4. Revisit remediation posture (auto-merge) — only after confidence

Eval findings are PR-only by design (Decision 3): a quality/safety fix is
riskier than a config fix, so a human reviews every one. This should stay the
default.

- Only after several eval-driven PRs have been reviewed and shown to be
  consistently correct should auto-merge even be *considered*, and then only
  for the lowest-risk metric categories — never for `safetyViolationRate`.
- No action now; this is a note to resist loosening the posture prematurely.

**Effort:** N/A (decision gate). **Depends on:** a track record from items 0–1.

---

## Suggested order

1. **Item 0** — live smoke run (unblocks trust in everything else).
2. **Item 2** — informational cost/latency/token trends (safe, cheap, builds
   observability).
3. **Item 1** — widen suite coverage as floors are set.
4. **Item 3** — rolling drift detection (the largest build).
5. **Item 4** — only ever revisit auto-merge once there's a track record.

## Explicitly NOT changing

- Read-only access to NEXT_HARNESS eval tables (never write).
- Local eval-shape mirrors (no `@/lib` import from the sibling repo).
- The `remediation-engine.ts` loop (eval findings remain just another work
  item).
