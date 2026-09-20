# Fixtures

`2026-09-01-failed-runs.json` is a point-in-time export of every failed row
in `harness_agent_runs` (`SELECT id, created_at, model, error FROM
harness_agent_runs WHERE status = 'failed' AND error IS NOT NULL ORDER BY
created_at DESC`), pulled directly from the live table on 2026-09-01. It's
real production data, not synthetic — used with `npm run remediate -- --seed
scripts/fixtures/2026-09-01-failed-runs.json` for the first remediation run
in an environment that has this session's MCP tool access but not a
standalone `MCP_ENDPOINT_URL` to fetch it over HTTP the normal way. Once
`MCP_ENDPOINT_URL`/`MCP_API_KEY` are configured (e.g. as CI secrets),
`npm run remediate` fetches live instead and this fixture stops being
needed for anything but tests.
