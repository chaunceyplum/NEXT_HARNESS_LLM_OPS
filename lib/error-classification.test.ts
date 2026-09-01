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
