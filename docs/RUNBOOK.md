# Runbook: running the remediation pipeline

There are two supported ways to run this on a schedule:

- **GitHub Actions (recommended, no server needed)** — `.github/workflows/llm-ops.yml`
  runs the report every 6 hours and lets you dispatch a remediation run
  (`Actions → LLM-Ops → Run workflow`, tick *remediate* and optionally
  *auto-merge*). Set these repository secrets: `MCP_ENDPOINT_URL`, `MCP_API_KEY`
  (if your gateway enforces auth), `ANTHROPIC_API_KEY`, and `GH_PAT` (push + PR
  rights on NEXT_HARNESS). Optionally set repository *variables* `TARGET_REPO`
  and `TARGET_BASE_BRANCH`.
- **A box (EC2 / cron)** — described below, for when you'd rather not use CI.

## The remediation engine

By default the fix step runs the **self-contained in-process engine**
(`lib/remediation-engine.ts`) — an agentic loop against the Anthropic API that
edits the target checkout through a sandboxed tool set (read/write/list/bash,
all confined to the repo root). It needs only an `ANTHROPIC_API_KEY`; there is
**no external CLI to install and no non-root requirement** — it runs fine in
CI or as any user.

If you'd rather use the external `claude` CLI instead, pass
`--engine claude-cli` (or set `REMEDIATE_ENGINE=claude-cli`) and install +
authenticate it (`npm install -g @anthropic-ai/claude-code`, `claude auth
login`). Note that Claude Code refuses some permission modes for a root
process, so that path specifically wants a non-root deploy user; the default
in-process engine has no such constraint.

## EC2 / cron setup

This mirrors `NEXT_HARNESS/DEPLOYMENT_GUIDE.md`'s "Option B: AWS EC2" setup —
same instance family/OS is fine, and if NEXT_HARNESS is already running on an
EC2 box under PM2, this can live on the same instance.

```bash
# 1. Node 20+ (skip if already installed for NEXT_HARNESS)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 2. Both repos, side by side (remediate.ts defaults to ../NEXT_HARNESS —
#    override with --repo or NEXT_HARNESS_PATH if you lay them out differently)
git clone https://github.com/chaunceyplum/NEXT_HARNESS.git
git clone https://github.com/chaunceyplum/NEXT_HARNESS_LLM_OPS.git
cd NEXT_HARNESS_LLM_OPS
npm install

# 3. Env vars
cp .env.local.example .env.local
# fill in MCP_ENDPOINT_URL (same value NEXT_HARNESS/.env.local uses)
export ANTHROPIC_API_KEY=sk-ant-...        # drives the in-process engine
export GITHUB_TOKEN=github_pat_...         # push + PR rights on NEXT_HARNESS
```

`NEXT_HARNESS` itself must be on the branch you want fixes pushed to, with a
clean working tree, before each run — `remediate.ts` checks both and refuses
to run otherwise rather than risk clobbering in-progress work.

## Running it

```bash
npm run report                                  # read-only — findings + pending optimizations
npm run remediate -- --dry-run                  # see the prompt it would send, no changes
npm run remediate                                # the real thing: fix, commit, push, open/update PR
npm run remediate -- --auto-merge                # …and merge the PR (squash by default)
```

`remediate` acts on both auto-diagnosed failure findings and any pending
items in the `optimizations/` backlog. Merging is opt-in: `--auto-merge`
(or `REMEDIATE_AUTO_MERGE=1`), method via `--merge-method squash|merge|rebase`.

## Scheduling

No CI system needed — a plain cron entry (as the same non-root deploy user)
is enough:

```bash
crontab -e
# Every 6 hours:
0 */6 * * * cd /home/ubuntu/NEXT_HARNESS_LLM_OPS && /usr/bin/npm run remediate >> /home/ubuntu/remediate.log 2>&1
```

`remediate.ts` is idempotent by design — it checks `remediation-ledger.json`
and only acts on findings that are new or have recurred since their last fix,
so an extra cron firing with nothing new to do is just a fast no-op
(`No new findings to remediate.`), not a duplicate PR.

## After a run

- Check `remediate.log` (or wherever you redirected output) for what it did.
- `git -C ../NEXT_HARNESS_LLM_OPS diff remediation-ledger.json` shows what got
  marked remediated and the PR link — commit that change.
- Review the opened PR on NEXT_HARNESS. By default the pipeline opens PRs and
  leaves merging to you; with `--auto-merge` it merges clean PRs itself
  (branch protection still applies).
