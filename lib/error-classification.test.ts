import { describe, expect, it } from 'vitest';
import { classifyError } from './error-classification';

// Every case below is a real, distinct error string pulled from the live
// harness_agent_runs table (`execute_sql`, 2026-09-01) — this is the actual
// production error population, not synthetic examples.
describe('classifyError', () => {
  it.each([
    ['[chat model call (bedrock:cheap)] Forbidden', 'provider_access'],
    ['[chat model call (bedrock:balanced)] Forbidden', 'provider_access'],
    ['[chat model call (bedrock:balanced)] Operation not allowed', 'provider_access'],
    ['[chat model call (bedrock:cheap)] Operation not allowed', 'provider_access'],
    ['[chat model call (bedrock:expensive)] Forbidden', 'provider_access'],
    [
      '[chat model call (bedrock:balanced)] anthropic.claude-sonnet-5 is not available for this account. ' +
        'You can explore other available models on Amazon Bedrock. For additional access options, contact AWS ' +
        'Sales at https://aws.amazon.com/contact-us/sales-support/',
      'provider_access',
    ],
    ['[chat model call (anthropic:haiku)] invalid x-api-key', 'provider_auth'],
    ['[chat model call (anthropic:opus)] invalid x-api-key', 'provider_auth'],
    [
      "[chat model call (anthropic:haiku)] Anthropic API key is missing. Pass it using the 'apiKey' parameter or the ANTHROPIC_API_KEY environment variable.",
      'provider_auth',
    ],
    [
      '[chat model call (anthropic:haiku)] Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
      'provider_quota',
    ],
    [
      '[chat model call (anthropic:opus)] Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
      'provider_quota',
    ],
    ['[chat model call (anthropic:haiku)] prompt is too long: 365912 tokens > 200000 maximum', 'context_length'],
    ['Something completely unrecognized happened', 'unknown'],
    ['MCP Error [-32000]: tool execution failed', 'tool_failure'],
  ] as const)('classifies %j as %s', (message, expected) => {
    expect(classifyError(message)).toBe(expected);
  });
});

// Error strings NEXT_HARNESS writes since durable runs, the kill switch,
// request timeouts and model routing (Sep 2026), taken from the harness
// source (lib/build-run.ts, lib/kill-switch.ts, app/api/runs/[id]/cancel,
// lib/fetch-timeout.ts, lib/mcp-client.ts, lib/llm/model-registry.ts).
describe('classifyError — newer harness failure messages', () => {
  it.each([
    ['Stopped by alice@example.com.', 'cancelled'],
    ['Stopped by the kill switch (ops@example.com: incident 42).', 'cancelled'],
    // A kill-switch reason is free text; it must not be read as a provider error.
    ['Stopped by the kill switch (ops: Bedrock Forbidden everywhere).', 'cancelled'],
    ['Cancelled', 'cancelled'],
    ['MCP call failed: Error: MCP tool adobe_list_segments timed out after 60s (timeout)', 'timeout'],
    ['MCP call failed: Error: MCP Error [-32000]: tool execution failed', 'tool_failure'],
    ['MCP call failed: TypeError: fetch failed', 'tool_failure'],
    ['Unknown model key "anthropic:sonnet-9". Available: bedrock:balanced, anthropic:haiku', 'config'],
    ['MCP_ENDPOINT_URL is not set. Please configure it in .env.local', 'config'],
    [
      '[chat model call (bedrock:balanced)] Forbidden\n(Not falling back to "bedrock:balanced-2": the failed attempt ' +
        'on "bedrock:balanced" already executed write/destructive tool calls, which a restarted run would repeat.)',
      'provider_access',
    ],
  ] as const)('classifies %j as %s', (message, expected) => {
    expect(classifyError(message)).toBe(expected);
  });
});
