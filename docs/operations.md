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
| `production` | `github-profile-prod` | Live aggregates | Hourly | Both read-only credentials required |

`deploy/resources.json` must contain top-level `stage` and `production` objects,
each with a `namespaceId` for its existing KV namespace. The configuration rejects
missing, malformed, or shared namespace IDs. IDs are configuration, not secrets.
Only these two modes are accepted; preview deployments and preview URLs are
disabled. The Vite plugin has remote bindings disabled and serves no static assets.

## Credentials and release

Provision two dedicated production Worker secrets through the protected provisioning flow:

| Secret | Credential and grant | API use |
| --- | --- | --- |
| `GITHUB_TOKEN` | Fine-grained PAT, all current/future repositories owned by afadesigns, Metadata read-only | Account identity and paginated owned repository metadata |
| `GITHUB_CENSUS_TOKEN` | Classic PAT with **only `read:user`** | Account identity and independent public/private repository census |

The exact Metadata-only PAT was tested and does not return `owned_private_repos`.
GitHub documents the private `/user` response under `read:user`; this separate
read-only credential supplies the census without repository or profile-write
scopes. The collector requires an exact normalized `read:user` scope header and
matching positive numeric account IDs for both credentials. Repository requests
always use the Metadata token. Only the six public aggregate fields are stored.

Missing or invalid private-count data fails with `private_coverage_unverified`
before any snapshot write. Every collection must match both the public count and
the complete public-plus-private census; partial inventories remain rejected.
Verify all-owned repository selection and compare the first result against an
independent complete inventory. Never put credentials in repository files,
command arguments, logs, stage bindings or chat.

### One-time provisioning and renewal

Use `scripts/provisioning-recipient.mjs` with its JSONL protocol. First complete a
`synthetic` transfer to the disposable relay Worker using the fixed test value.
The browser encrypts locally with RSA-OAEP; the temporary Worker stores only
ciphertext, under the exact SHA-256 receipt, with a hard expiry and no logs.
The recipient's private key remains in memory.

For the live pair, prepare `census`, transfer the read:user-only credential, and
consume its exact receipt. This validates and holds the credential in memory;
it does not install a secret. Then prepare `live` and transfer the existing
Metadata credential. The original census deadline remains in force across both
steps. After identity, full-inventory and independent aggregate checks succeed,
one fixed native cf bulk-secret request installs both production secrets through
an anonymous pipe. No credential file is written. Closing input, expiration or
stopping the recipient clears retained credentials; installation outcomes that
cannot be confirmed require reconciliation before any new attempt.

Delete the temporary relay Worker and its isolated KV namespace after the
transfer, stop the recipient and clear the browser clipboard. Keep the original
static SVG as a rollback. Record token expiry dates and repeat the same scoped
procedure before expiration; an expired token preserves the last good snapshot
but prevents fresh hourly counts.

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

## Verified release state — 2026-11-19

- Both explicit modes have module SHA-256 `f874cbfb8fe8d01c77054b665bc9c90373caaf463751cfd65cb2d8c6fa599f2c`. Frozen candidates are under `.cloudflare/releases/2026-11-18-{stage,production}-f874cbfb8fe8`; build-date labels use UTC.
- The new application gate passed **82 tests**, including the actual compiled workerd path, with zero failures/skips. Protected provisioning passed **33 tests**, including real anonymous-pipe transport, descendant termination, matching receipts, role binding, EOF/stop cancellation and shared expiry.
- Stage is live at `https://github-profile-stage.afadesign.workers.dev/terminal.svg`, version `501aacb5-c683-462a-9af4-fb3160d2b118`. It has isolated synthetic counters and no credentials or cron. GET/HEAD, ETag, route/method handling and exact local SVG equality passed; see `deploy/verification-2026-11-19-stage.json`.
- Production code is uploaded at version `c9f3445a-c3d6-48c3-8cc5-314a8173eca0` with the same verified bytes. Activation is disabled: no secrets or schedule, refresh false, workers.dev and previews off, empty production KV. See `deploy/verification-2026-11-19-production-prepared.json`.
- Automatic approval review blocked creation of the separate classic `read:user` census token pending explicit owner authorization. The existing all-owned Metadata-read PAT expires on 2026-12-18; the census form is prepared with the same expiration. No classic token was generated. README still points to the original static SVG.
- The synthetic end-to-end transfer succeeded. All recipient processes stopped, and the temporary relay Worker/KV were deleted and verified absent. Restart provisioning with fresh ephemeral resources after approval.
- Cloudflare Browser Integrity Check rejects Python urllib's default client with error 1010 on workers.dev. Unmodified curl and the actual Cloud Browser work. No account protection was changed.

The reviewed implementation is published in signed commit `b3e44c2c62e058b4c42377cd0f5e7f1e6e06ad83`; normal push, signature and exact remote-main equality were verified.

## Configuration references

- [Programmatic Cloudflare configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
- [Configuration fields and trigger builders](https://developers.cloudflare.com/cf/projects/config-explorer/)
- [Vite plugin version 2 migration](https://developers.cloudflare.com/cf/wrangler/migrate/)

- [GitHub authenticated user census](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)
- [GitHub read:user scope and scope headers](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
