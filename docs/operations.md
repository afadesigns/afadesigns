# Profile statistics

The Worker serves `GET` and `HEAD /terminal.svg`. Production refreshes its stored
snapshot hourly at minute zero (UTC). Public image requests read KV only; they
never call GitHub or refresh the data.

## Scope and data

The collector verifies that the GitHub credential belongs to `afadesigns`, then
reads every page of owned repositories with both public and private visibility.
Owned forks count. Collaborator and organization repositories do not count.
Stars are stars received by these repositories; followers come from the account.

KV key `github-profile:v1` contains only `schemaVersion`, `username`, `followers`,
`stars`, `repositories`, and `updatedAt`. Repository names, API responses, and
credentials are never stored in the snapshot or returned to visitors. The SVG's
layout, links, animation, and framework text remain unchanged.

## Environments

| Mode | Worker | Data | Refresh | GitHub secret |
| --- | --- | --- | --- | --- |
| `stage` | `github-profile-stage` | Synthetic aggregates in separate KV | Disabled, no cron | Absent |
| `production` | `github-profile-prod` | Live aggregates | Hourly | Required |

`deploy/resources.json` must contain top-level `stage` and `production` objects,
each with a `namespaceId` for its existing KV namespace. The configuration rejects
missing, malformed, or shared namespace IDs. IDs are configuration, not secrets.
Only these two modes are accepted; preview deployments and preview URLs are
disabled. The Vite plugin has remote bindings disabled and serves no static assets.

## Credentials and release

Provision `GITHUB_TOKEN` as a production Worker secret through the established
secret-management flow. Use read access to metadata for **all repositories owned
by the account**, including private repositories. The credential must also let
`/user` return a valid non-negative integer `owned_private_repos`. Missing or
invalid private-count data fails with `private_coverage_unverified` before any
snapshot write. Every collection must match both the account's public count and
its complete public-plus-private total; restricted or partial inventories are
rejected. Verify the credential's repository selection and compare the first
result against an independent complete inventory. Do not put credentials in the
repository, command arguments, logs, or stage bindings.

The reviewed compatibility date is `2026-10-13`, matching the installed workerd. Use `redirect: 'manual'` for GitHub requests and explicitly reject non-200 responses; workerd does not support the Fetch `error` redirect mode.

Run the focused tests and build explicitly for the intended environment:

```sh
npm test
npm run build:stage
npm run build:production
PROFILE_WORKER_ARTIFACT=/absolute/path/to/frozen/bundle/index.js npm test
```

Use the pinned `cf` CLI and the same reviewed source revision for both builds.
Review the build's Worker name, KV binding, secret declaration, and cron before
deploying. Validate stage with synthetic aggregates, then deploy production and
wait for its first successful scheduled refresh, or use an authenticated internal
initialization procedure. There is no public refresh endpoint.

Before pointing the profile README at the production `/terminal.svg` URL, verify
the production aggregate counts, successful cron execution, absence of private
repository details, and the unchanged SVG design. Check GET, HEAD, ETag
revalidation, and the stored timestamp. Keep the prior static SVG available for
rollback. Deployment, secret provisioning, and real Worker runtime checks are
separate from the dependency-free Node tests.

## Failure handling and monitoring

An unsuccessful or incomplete collection never overwrites the last good snapshot.
Valid old data remains available with its original timestamp. Responses include
`X-Profile-Stats: fresh` or `stale` (older than three hours), and
`X-Profile-Stats-Updated` with the last successful collection time. Missing,
malformed, or unreadable data returns HTTP 503 with unavailable placeholders and
`X-Profile-Stats: unavailable`, never fabricated zero counts.

The image uses `Cache-Control: no-cache` and a content-derived ETag. GitHub's image
proxy may still delay visible updates. Worker logs record only a successful
timestamp or a fixed failure code; observability query strings are redacted and
traces are sampled at one percent. Investigate repeated refresh failures or a
stale timestamp using the scheduled invocation logs. Correct access or upstream
failures before the next refresh; do not replace good data with an estimate.

## Verified release state — 2026-11-18

- `github-profile-stage` was uploaded through the authenticated Cloudflare plugin and read back at version `58c9d5c5-43bd-4812-b907-8f8dcd82fac7` (100 percent active).
- Its live endpoint is `https://github-profile-stage.afadesign.workers.dev/terminal.svg`; current displayed counters are synthetic test data, with a 24-hour KV expiry. No token or cron is attached.
- Both build modes have module SHA-256 `aa01ed950809bbb4d5d5a283c0bcd30d8f7238fe45499d2045029cf5304b96b4`. Retained frozen candidates are under `.cloudflare/releases/`; keep them until the production decision is resolved.
- The full compiled runtime gate passed 59 tests, with no failures or skips. Remote missing-data/route/method checks and populated GET/HEAD/ETag revalidation are recorded in `deploy/verification-2026-11-18.json`.
- Cloudflare Browser Integrity Check rejects Python urllib's default client with error 1010 on workers.dev. Unmodified curl and the real Cloud Browser reach and render the endpoint. Do not disable account-wide protection to work around a test-client signature.
- Production has not been deployed; README still references the verified static SVG. The exact metadata-only GitHub credential must be provisioned and successfully pass live private-coverage validation before production activation.

## Configuration references

- [Programmatic Cloudflare configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
- [Configuration fields and trigger builders](https://developers.cloudflare.com/cf/projects/config-explorer/)
- [Vite plugin version 2 migration](https://developers.cloudflare.com/cf/wrangler/migrate/)
