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

Both installed GitHub credentials now have **no expiration**, as explicitly
approved by the owner on 2026-11-19. The `read:user` census credential remains in
place. The Metadata credential that previously expired on **2026-12-18** was
replaced through the protected `metadata-renewal` procedure. Saved GitHub
settings were rechecked after regeneration: afadesigns, all owned repositories,
Metadata read-only and No expiration. The unchanged deployed collector then
completed a successful scheduled refresh using the new Metadata credential and
the retained census credential. The earlier approval rejection and expiry are
preserved in the initial release history below.

Recipient shutdown is idempotent after a confirmed installation. Repeated stop
or EOF preserves the confirmed result and clears retained key material; genuinely
uncertain installation attempts still require reconciliation before retry.

### Metadata-only renewal

This distinct renewal procedure was completed and verified on 2026-11-19.
It replaces only `GITHUB_TOKEN`, preserving the installed census credential.
The paired `census` then `live` path above remains the initial provisioning
procedure.

1. Start a fresh protected recipient and complete a `synthetic` transfer using
   the fixed test value. Then prepare `metadata-renewal` and transfer only the
   replacement fine-grained Metadata-read credential. Verify its GitHub settings
   show afadesigns, all current/future owned repositories, Metadata read-only and
   No expiration. Use the same encrypted relay, exact receipt verification,
   memory-only decryption and hard deadline.
2. Validate the candidate's account identity and complete bounded owner
   inventory. Compare its canonical inventory fingerprint and aggregates with a
   fresh inventory read through the existing authenticated gh CLI. Keep raw
   repository records in memory; emit only safe aggregate or validation results.
   Do not synthesize a private census or change the shared collector's checks.
3. Install with a native merge-only request containing `GITHUB_TOKEN` alone:

   `{"secrets":{"GITHUB_TOKEN":{"name":"GITHUB_TOKEN","type":"secret_text","text":"<in-memory candidate>"}}}`

   The placeholder represents the value supplied through protected stdin.
   Omit `GITHUB_CENSUS_TOKEN` entirely so its installed value is preserved. The
   census credential stays in the Worker and is not read back or retransferred.
   Record the resulting active Worker version and activation time.
4. Require a successful actual scheduled run on that new version. Provisioning
   preflight does not substitute for the deployed collector's private-census
   proof using the retained census credential. In Observability, match the
   scheduled completion with outcome `ok` and its `profile_stats_updated` log
   by request ID and new script-version ID. Require a post-rotation update and a
   matching valid six-field production KV snapshot. A failed or incomplete
   collection must retain the last good snapshot; do not record renewal success
   from secret installation alone.

Use the next natural hourly invocation or a bounded temporary minute schedule
for runtime verification, then confirm that only `0 * * * *` remains configured.
Apply the same recipient, relay and clipboard cleanup described above. Record
the live outcome and new credential lifetime only after verification.

### Application release verification

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

## Verified Metadata renewal — 2026-11-19

The approved Metadata-token replacement is complete. Both production GitHub
credentials now have No expiration. The separate renewal receipt is
`deploy/verification-2026-11-19-metadata-renewal.json`; the original production
receipt remains unchanged as the initial-release record.

- Saved GitHub settings were rechecked after regeneration at approximately 01:16 UTC: afadesigns, all current/future owned repositories, Metadata read-only and No expiration. The protected recipient installed only `GITHUB_TOKEN`; the existing `GITHUB_CENSUS_TOKEN` was omitted from the merge request and preserved.
- The full helper suite passed **44 tests** with independent review approval. Synthetic transfer and live `metadata-renewal` succeeded. Candidate inventory/fingerprint validation agreed with a fresh gh inventory at **6 followers, 77 stars and 21 owned repositories**.
- The secret update activated version `9e40f9ae-5913-468b-b229-3815ae15d502` at `2026-11-19T01:15:02.353228Z`, deployment `d38bbfef-0aa6-4579-ba53-b613db057016`, serving 100% of traffic. Independent module readback at `01:16:52.201Z` verified the unchanged **14,598-byte** module SHA-256 `f874cbfb8fe8d01c77054b665bc9c90373caaf463751cfd65cb2d8c6fa599f2c`; runtime settings, safe bindings and both secret names remained intact.
- A strict, temporary Observability query matched scheduled completion and `profile_stats_updated` logs to the new version and the same request IDs after activation. The first success was at `01:16:02.284Z`; a second at `01:17:02.332Z` wrote `updatedAt=2026-11-19T01:17:02.154Z`. Authenticated KV readback at `01:17:45.607Z` matched that exact timestamp and the six-field **6/77/21** aggregate. This is the required deployed private-census proof with the retained census credential.
- The temporary minute schedule was replaced with **only `0 * * * *`** at `01:18:07.20195Z`; readback at `01:18:08.227Z` confirmed the final hourly UTC schedule. The successful renewal invocations used the temporary schedule; its remaining invocations can continue briefly while the change propagates.
- Independent HTTP verification at `01:22:58.027190Z` passed GET/HEAD 200, conditional 304, unknown route 404 and POST 405. The **2,818-byte** SVG exactly matched local rendering of the verified snapshot updated at `01:22:01.956Z`, with SHA-256/ETag `d33a9968a4c763d459432a530cdd772760e729ed2afd3c028b6f11b16f41a071`, fresh/no-cache headers and matching timestamps. Each successful collection changes the SVG comment timestamp, so a changed body hash or ETag is expected.
- The actual GitHub profile was reloaded after rotation on 2026-11-19. Its complete Camo image remained **950×480**, showing **6/77/21** with the existing design. No exact browser observation timestamp was captured.
- The temporary relay Worker and KV were deleted and both returned 404 at `01:16:26.843Z`. Recipient 2533670 exited 0 with no retained private key or census credential and no reconciliation required. Plaintext credentials were removed from both clipboards, the token page was reloaded without plaintext and the relay tab was closed.

## Verified production release — 2026-11-19

Production is serving the profile at
https://github-profile-prod.afadesign.workers.dev/terminal.svg.
The README cutover and actual GitHub rendering are verified. The production
receipt is `deploy/verification-2026-11-19-production.json`; it includes the
HTTP, scheduled-execution and actual browser-rendering evidence.

- The reviewed module remains `f874cbfb8fe8d01c77054b665bc9c90373caaf463751cfd65cb2d8c6fa599f2c`. Activation used version `3fa9ea41-ed7b-47b6-be84-ff5715c8dda9`, deployment `abe52950-e6b5-45f4-973e-40ce98e29b0b`, with production KV, both fixed secret bindings and refresh enabled. The application/compiled-runtime gate passed **82 tests**; the final provisioning suite passed **35 tests**, including idempotent shutdown.
- A real scheduled invocation at `2026-11-19T00:07:39.947Z` completed successfully with `profile_stats_updated`, writing snapshot `00:07:39.834Z`. A later KV read verified **6 followers, 77 stars and 21 owned repositories**, updated at `00:12:39.532Z`. This confirms the actual deployed collection and both installed credentials.
- The temporary bootstrap schedule was replaced with **only `0 * * * *`** at `00:08:29.292258Z`. Independent readback at `00:10:17.023Z` and root readback at `00:15:43.710Z` confirmed the hourly UTC configuration. The observed successful invocation preceded this restoration.
- At `00:10:32.326Z`, GET/HEAD returned 200, ETag revalidation 304, an unknown route 404 and POST 405. Responses were fresh with no-cache. The **2,818-byte** SVG matched local rendering exactly, SHA-256 `e4cf0f9b4b1ebfcfa2d7984ba8aae3bfc1762cda5dae83a7b2f95641805440d7`.
- README's image source alone changed in signed, pushed commit `a3bb55e498e877328abefeadc871594b5da60324`; exact remote equality was verified. Reloading the actual GitHub profile confirmed the canonical production URL and a complete Camo image at **950×480**, displaying **6/77/21** in the preserved terminal design.
- Disposable relay resources and the recipient are cleaned up. Once-only token displays and relay tabs were closed or reloaded; the classic settings page shows only its read:user grant and No expiration. The unsubmitted fine-grained No expiration regeneration form remains for a separate owner decision. Its current **2026-12-18** expiry is an operational follow-up, not a pending production activation step.

This initial release checkpoint includes the tested helper correction and
completed production receipt. At that checkpoint, the Metadata-token lifetime
decision remained the operational follow-up. Its subsequent approval and
completed renewal are recorded above. The historic preparation record below
preserves evidence of the earlier state.

## Verified preparation — 2026-11-19

This section records the preparation checkpoint before production activation.

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
