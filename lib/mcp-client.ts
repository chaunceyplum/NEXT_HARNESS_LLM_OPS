/**
 * MCP client — HTTP bridge to call MCP tools via JSON-RPC 2.0.
 *
 * Deliberately the same bridge NEXT_HARNESS/lib/mcp-client.ts uses, pointed
 * at the same MCP_ENDPOINT_URL. This pipeline reads harness_agent_runs
 * through the MCP server's `execute_sql` tool because that table lives in
 * the MCP server's own Postgres — this repo never gets its own database
 * credentials (see NEXT_HARNESS/ARCHITECTURE.md: the MCP server is the only
 * thing in this picture holding real credentials).
 */

const MCP_ENDPOINT = process.env.MCP_ENDPOINT_URL;

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (process.env.MCP_API_KEY) headers['x-api-key'] = process.env.MCP_API_KEY;
  if (process.env.MCP_AUTH_TOKEN) headers['Authorization'] = `Bearer ${process.env.MCP_AUTH_TOKEN}`;
  return headers;
}

async function describeError(response: Response): Promise<string> {
  const bodyText = await response.text().catch(() => '');
  const bodyPreview = bodyText ? ` — ${bodyText.slice(0, 300)}` : '';
  return `HTTP ${response.status}: ${response.statusText}${bodyPreview}`;
}

interface MCPResponse<T = unknown> {
  jsonrpc: string;
  id: string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: Record<string, unknown>;
  };
}

/** Unwrap the MCP tool response envelope: { content: [{ type: "text", text: "<json>" }] } -> parsed payload. */
function unwrapToolResult(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && Array.isArray((raw as { content?: unknown }).content)) {
    const content = (raw as { content: Array<{ type?: string; text?: string }> }).content;
    if (content.length > 0 && content[0]?.type === 'text' && typeof content[0]?.text === 'string') {
      const text = content[0].text;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return raw;
}

export async function callMcpTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  if (!MCP_ENDPOINT) {
    throw new Error('MCP_ENDPOINT_URL is not set. Please configure it in .env.local');
  }

  const requestId = `llmops-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const response = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });

  if (!response.ok) {
    throw new Error(await describeError(response));
  }

  const result = (await response.json()) as MCPResponse;

  if (result.error) {
    throw new Error(
      `MCP Error [${result.error.code}]: ${result.error.message}` +
        (result.error.data ? ` - ${JSON.stringify(result.error.data)}` : '')
    );
  }

  if (result.result === undefined) {
    throw new Error('Invalid MCP response: no result field');
  }

  return unwrapToolResult(result.result);
}
