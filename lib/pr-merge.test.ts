import { describe, expect, it, vi } from 'vitest';
import { mergeOrQueue, type GithubRequest } from './pr-merge';

const pr = { owner: 'o', repo: 'r', number: 7, nodeId: 'PR_node' };

function respond(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('mergeOrQueue', () => {
  it('merges directly when GitHub allows it', async () => {
    const request = vi.fn<GithubRequest>(async () => respond(200, { merged: true }));
    await expect(mergeOrQueue(request, pr, 'squash')).resolves.toEqual({ kind: 'merged' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('/repos/o/r/pulls/7/merge');
  });

  it('queues native auto-merge when required checks are still pending', async () => {
    const request = vi.fn<GithubRequest>(async (path) =>
      path === '/graphql'
        ? respond(200, { data: { enablePullRequestAutoMerge: { clientMutationId: null } } })
        : respond(405, { message: 'Required status check "Typecheck, lint, test, build" is expected.' })
    );
    const outcome = await mergeOrQueue(request, pr, 'squash');
    expect(outcome.kind).toBe('auto-merge-queued');
    const body = JSON.parse(String(request.mock.calls[1][1]?.body));
    expect(body.variables).toEqual({ id: 'PR_node', method: 'SQUASH' });
  });

  it('leaves the PR open, without throwing, when auto-merge is not enabled for the repo', async () => {
    const request = vi.fn<GithubRequest>(async (path) =>
      path === '/graphql'
        ? respond(200, { errors: [{ message: 'Auto merge is not allowed for this repository' }] })
        : respond(405, { message: 'Required status check is expected.' })
    );
    const outcome = await mergeOrQueue(request, pr, 'merge');
    expect(outcome).toMatchObject({ kind: 'left-open', autoMergeError: 'Auto merge is not allowed for this repository' });
  });
});
