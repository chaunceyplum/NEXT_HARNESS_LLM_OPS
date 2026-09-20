/**
 * Groups classified failures into stable "findings" (one per model+category
 * signature) and checks them against the remediation ledger so a finding
 * that's already been fixed isn't re-reported forever — unless it recurs
 * *after* the fix, which means the fix didn't address the root cause.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyError, type ErrorCategory } from './error-classification';
import type { FailedRun } from './runs-repository';

export interface Finding {
  signature: string;
  model: string;
  category: ErrorCategory;
  count: number;
  firstSeen: string;
  lastSeen: string;
  sampleErrors: string[];
  suggestedFix: string;
}

export interface LedgerEntry {
  prUrl: string;
  remediatedAt: string;
}

export type Ledger = Record<string, LedgerEntry>;

export function findingSignature(model: string, category: ErrorCategory): string {
  return `${model}::${category}`;
}

function suggestFix(model: string, category: ErrorCategory): string {
  switch (category) {
    case 'provider_access':
      return (
        `"${model}" is failing on every attempt with a provider access/authorization error. Likely causes: ` +
        `Bedrock model access not granted for this model in this AWS account/region (AWS Console -> Bedrock -> ` +
        `Model access), or DEFAULT_MODEL routing unpinned requests at a model with no verified access. ` +
        `Recommended fix: add a model-health circuit breaker (lib/llm/model-registry.ts + lib/llm/agent.ts) that ` +
        `retries an unpinned request against the next healthy same-tier model after a provider-access failure, ` +
        `and stop defaulting to a model with no verified access.`
      );
    case 'provider_auth':
      return (
        `"${model}" is failing with an invalid or missing API key. Recommended fix: verify the relevant API key ` +
        `env var is set and valid wherever NEXT_HARNESS is deployed; the same model-health circuit breaker used ` +
        `for provider_access should also stop retrying a model that keeps failing on auth.`
      );
    case 'provider_quota':
      return (
        `"${model}"'s account has insufficient credit/quota. Recommended fix: check billing for that provider; ` +
        `the same model-health circuit breaker should stop repeatedly selecting a model that's failing on quota.`
      );
    case 'context_length':
      return (
        `A run overflowed the model's context window. Recommended fix: cap individual tool-result size before it ` +
        `re-enters the agent loop's context (lib/llm/agent.ts / lib/llm/tool-catalog.ts), extending the existing ` +
        `RAG-result capping pattern to tool results generally.`
      );
    case 'tool_failure':
      return (
        `A specific MCP tool call failed independent of the chat model provider. Recommended fix: inspect the ` +
        `failing tool name/arguments in the run's stored request/result and check the MCP server's handling of ` +
        `that tool.`
      );
    default:
      return `Uncategorized error signature — needs manual triage before an automated fix can be proposed.`;
  }
}

export function buildFindings(failedRuns: FailedRun[]): Finding[] {
  interface Group {
    model: string;
    category: ErrorCategory;
    count: number;
    firstSeen: string;
    lastSeen: string;
    sampleErrors: string[];
  }

  const groups = new Map<string, Group>();

  for (const run of failedRuns) {
    const category = classifyError(run.error);
    const signature = findingSignature(run.model, category);
    const existing = groups.get(signature);

    if (!existing) {
      groups.set(signature, {
        model: run.model,
        category,
        count: 1,
        firstSeen: run.createdAt,
        lastSeen: run.createdAt,
        sampleErrors: [run.error],
      });
      continue;
    }

    existing.count += 1;
    if (run.createdAt < existing.firstSeen) existing.firstSeen = run.createdAt;
    if (run.createdAt > existing.lastSeen) existing.lastSeen = run.createdAt;
    if (existing.sampleErrors.length < 3 && !existing.sampleErrors.includes(run.error)) {
      existing.sampleErrors.push(run.error);
    }
  }

  return [...groups.entries()]
    .map(([signature, g]) => ({
      signature,
      model: g.model,
      category: g.category,
      count: g.count,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      sampleErrors: g.sampleErrors,
      suggestedFix: suggestFix(g.model, g.category),
    }))
    .sort((a, b) => b.count - a.count);
}

const DEFAULT_LEDGER_PATH = fileURLToPath(new URL('../remediation-ledger.json', import.meta.url));

export function loadLedger(path: string = DEFAULT_LEDGER_PATH): Ledger {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8')) as Ledger;
}

export function saveLedger(ledger: Ledger, path: string = DEFAULT_LEDGER_PATH): void {
  writeFileSync(path, JSON.stringify(ledger, null, 2) + '\n', 'utf-8');
}

/**
 * Findings not yet remediated, or remediated but recurring again since the
 * fix landed (lastSeen after remediatedAt) — the latter means the fix
 * didn't address the root cause and the finding needs attention again.
 */
export function newFindings(findings: Finding[], ledger: Ledger): Finding[] {
  return findings.filter((finding) => {
    const entry = ledger[finding.signature];
    if (!entry) return true;
    return finding.lastSeen > entry.remediatedAt;
  });
}
