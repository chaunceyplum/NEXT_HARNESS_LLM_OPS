# Runbook: running the remediation pipeline on EC2

This mirrors `NEXT_HARNESS/DEPLOYMENT_GUIDE.md`'s "Option B: AWS EC2" setup —
same instance family/OS is fine, and if NEXT_HARNESS is already running on an
EC2 box under PM2, this can live on the same instance. The one hard
requirement that's specific to this repo: **it must run as a non-root user.**

## Why non-root matters here

`scripts/remediate.ts` shells out to the `claude` CLI in non-interactive mode
(`claude -p`) to actually edit NEXT_HARNESS, run its tests, and commit. That
subprocess needs pre-approved tool access to do that without a human
approving each step — this script grants it via an explicit `--allowed-tools`
list (Read/Edit/Write/Glob/Grep/Bash), not a full permission bypass.

Even so: **do not run this as root.** It was built and validated in a
sandboxed session that runs as root, and every attempt to actually execute
the `claude` subprocess there was refused — Claude Code has a hard-coded
safeguard against a root process expanding its own tool access, and (in that
particular sandbox) an additional layer above the CLI blocked spawning a
nested Claude Code process at all. Neither of those is a bug to route around;
they're exactly the kind of guardrail that should stay in place. A normal
non-root deploy user (e.g. `ubuntu` on an EC2 box, same as
`NEXT_HARNESS/DEPLOYMENT_GUIDE.md` already uses) doesn't hit either
restriction. **The first real run of this pipeline needs to happen from a
host like that, not from a locked-down orchestration sandbox** — that's the
reason this repo's first PR into NEXT_HARNESS didn't get opened automatically
during initial development; the pipeline is built and unit-tested against
real production data, just not yet executed end-to-end anywhere it's
actually allowed to run for real.

## Setup

```bash
# As a non-root user (e.g. ubuntu), on the same box as NEXT_HARNESS or a
# small dedicated instance — this doesn't need to serve HTTP traffic.

# 1. Node 20+ (skip if already installed for NEXT_HARNESS)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 2. Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude auth login          # interactive, once — stores credentials under ~/.claude
claude auth status         # confirm

# 3. Both repos, side by side (remediate.ts defaults to ../NEXT_HARNESS —
#    override with --repo or NEXT_HARNESS_PATH if you lay them out differently)
git clone https://github.com/chaunceyplum/NEXT_HARNESS.git
git clone https://github.com/chaunceyplum/NEXT_HARNESS_LLM_OPS.git
cd NEXT_HARNESS_LLM_OPS
npm install

# 4. Env vars
cp .env.local.example .env.local
# fill in MCP_ENDPOINT_URL (same value NEXT_HARNESS/.env.local uses)
# GITHUB_TOKEN needs push access to NEXT_HARNESS and permission to open PRs
export GITHUB_TOKEN=github_pat_...
```

`NEXT_HARNESS` itself must be on the branch you want fixes pushed to, with a
clean working tree, before each run — `remediate.ts` checks both and refuses
to run otherwise rather than risk clobbering in-progress work.

## Running it

```bash
npm run report                                  # read-only — see current findings
npm run remediate -- --dry-run                  # see the prompt it would send, no changes
npm run remediate                                # the real thing: fix, commit, push, open/update PR
```

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
- Review and merge the opened PR on NEXT_HARNESS like any other — this
  pipeline opens PRs, it doesn't merge them.
