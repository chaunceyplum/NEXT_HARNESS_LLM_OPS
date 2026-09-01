/**
 * Buckets a harness_agent_runs `error` string into a stable category.
 *
 * The patterns below are drawn directly from the live table (queried
 * 2026-09-01): every one of the 39 recorded failures matched one of these —
 * there were no tool-call or agent-logic failures in the data at all, only
 * LLM-provider config/access errors and one context-length overflow. Order
 * matters: more specific patterns are checked before the generic
 * `provider_access` catch-all.
 */

export type ErrorCategory =
  | 'provider_auth'
  | 'provider_access'
  | 'provider_quota'
  | 'context_length'
  | 'tool_failure'
  | 'unknown';

const RULES: Array<{ category: ErrorCategory; pattern: RegExp }> = [
  // Anthropic-direct: bad/missing credentials.
  { category: 'provider_auth', pattern: /invalid x-api-key/i },
  { category: 'provider_auth', pattern: /api key is missing/i },
  // Anthropic-direct: account has no credit.
  { category: 'provider_quota', pattern: /credit balance is too low/i },
  // Context window exceeded.
  { category: 'context_length', pattern: /prompt is too long/i },
  // Bedrock: account/region has no model access grant, or the model id
  // isn't available to this account (AWS Console -> Bedrock -> Model
  // access, separate from IAM).
  { category: 'provider_access', pattern: /is not available for this account/i },
  { category: 'provider_access', pattern: /operation not allowed/i },
  { category: 'provider_access', pattern: /\bforbidden\b/i },
  // A JSON-RPC error surfaced by the MCP dispatcher itself (as opposed to
  // the chat-model-provider errors above) — a real tool-call failure.
  { category: 'tool_failure', pattern: /^MCP Error \[/i },
];

export function classifyError(message: string): ErrorCategory {
  for (const rule of RULES) {
    if (rule.pattern.test(message)) return rule.category;
  }
  return 'unknown';
}
