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
  | 'cancelled'
  | 'provider_auth'
  | 'provider_access'
  | 'provider_quota'
  | 'context_length'
  | 'timeout'
  | 'config'
  | 'tool_failure'
  | 'unknown';

/**
 * Categories that describe a run someone deliberately stopped, not a defect.
 * They're excluded from findings so they never drive a remediation PR.
 */
export const NON_ACTIONABLE_CATEGORIES: ReadonlySet<ErrorCategory> = new Set(['cancelled']);

const RULES: Array<{ category: ErrorCategory; pattern: RegExp }> = [
  // A run stopped on purpose — NEXT_HARNESS saves these as status 'failed'
  // with the abort reason as the error (lib/build-run.ts): "Stopped by
  // <user>." from POST /api/runs/:id/cancel, "Stopped by the kill switch
  // (...)." from lib/kill-switch.ts, or a bare "Cancelled". Checked first:
  // a kill-switch reason is free text and could contain any other pattern.
  { category: 'cancelled', pattern: /^Stopped by /i },
  { category: 'cancelled', pattern: /^Cancelled$/i },
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
  // A request that hit its deadline (NEXT_HARNESS lib/fetch-timeout.ts:
  // "<label> timed out after <n>s (timeout)"), e.g. a hung MCP tool call.
  { category: 'timeout', pattern: /timed out after \d+s/i },
  // The harness itself is misconfigured: a model key that isn't in the
  // registry, an unsupported provider, or no MCP endpoint.
  { category: 'config', pattern: /unknown model key/i },
  { category: 'config', pattern: /unsupported provider/i },
  { category: 'config', pattern: /MCP_ENDPOINT_URL is not set/i },
  // A JSON-RPC error surfaced by the MCP dispatcher itself (as opposed to
  // the chat-model-provider errors above) — a real tool-call failure. The
  // harness wraps it ("MCP call failed: Error: MCP Error [...]"), so this
  // isn't anchored to the start of the message.
  { category: 'tool_failure', pattern: /MCP Error \[/i },
  { category: 'tool_failure', pattern: /^MCP call failed:/i },
];

export function classifyError(message: string): ErrorCategory {
  for (const rule of RULES) {
    if (rule.pattern.test(message)) return rule.category;
  }
  return 'unknown';
}
