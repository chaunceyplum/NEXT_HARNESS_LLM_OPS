/**
 * Merging a remediation PR. NEXT_HARNESS runs CI (typecheck, lint, test,
 * build) on every PR, so right after the PR opens an immediate merge is
 * usually refused while required checks are pending. When that happens this
 * queues GitHub's native auto-merge instead, which merges once the checks
 * pass. If neither works (e.g. auto-merge isn't enabled in the repo's
 * settings), the PR is left open for a human — that's an outcome, not an error.
 */

export type MergeMethod = 'squash' | 'merge' | 'rebase';

export type MergeOutcome =
  | { kind: 'merged' }
  | { kind: 'auto-merge-queued'; mergeError: string }
  | { kind: 'left-open'; mergeError: string; autoMergeError: string };

/** Same signature as the GitHub REST helper in scripts/remediate.ts (path relative to api.github.com). */
export type GithubRequest = (path: string, init?: RequestInit) => Promise<Response>;

const ENABLE_AUTO_MERGE = `mutation($id: ID!, $method: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { clientMutationId }
}`;

async function describeFailure(response: Response): Promise<string> {
  return `HTTP ${response.status} ${await response.text().catch(() => '')}`.trim();
}

export async function mergeOrQueue(
  request: GithubRequest,
  pr: { owner: string; repo: string; number: number; nodeId: string },
  method: MergeMethod
): Promise<MergeOutcome> {
  const merge = await request(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge`, {
    method: 'PUT',
    body: JSON.stringify({ merge_method: method }),
  });
  if (merge.ok) return { kind: 'merged' };
  const mergeError = await describeFailure(merge);

  const queue = await request('/graphql', {
    method: 'POST',
    body: JSON.stringify({ query: ENABLE_AUTO_MERGE, variables: { id: pr.nodeId, method: method.toUpperCase() } }),
  });
  // GraphQL reports mutation failures as 200 with an `errors` array.
  const body = queue.ok ? ((await queue.json().catch(() => ({}))) as { errors?: Array<{ message?: string }> }) : undefined;
  if (queue.ok && !body?.errors?.length) return { kind: 'auto-merge-queued', mergeError };

  const autoMergeError = body?.errors?.length
    ? body.errors.map((e) => e.message ?? 'unknown error').join('; ')
    : await describeFailure(queue);
  return { kind: 'left-open', mergeError, autoMergeError };
}
