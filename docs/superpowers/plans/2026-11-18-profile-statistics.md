# Automatic profile statistics implementation plan

> **For agentic workers:** Execute the approved plan task by task; root owns integration and publication.

**Goal:** Keep the current GitHub terminal profile automatically current without manual statistics edits.

**Architecture:** An hourly Cloudflare Worker collects authenticated GitHub totals and writes one validated aggregate snapshot to a dedicated KV namespace. A public SVG endpoint renders the existing terminal design from the last successful snapshot. Staging has isolated storage and synthetic values; no live scheduler or credentials.

**Tech Stack:** Owned JavaScript ES modules, Web APIs, Cloudflare Workers/KV, existing cf tooling, Node built-in tests.

**Spec:** HANDOFF.md and the owner's approval in this conversation.

## Global constraints

- Preserve the exact existing terminal layout, colors, typography, links and framework text.
- Count every owned repository, public/private/fork; stars are received stars across those repositories.
- Never emit private repository names, raw GitHub payloads or credentials.
- No GitHub Actions; no automatic Git commits for counter updates.
- Hourly collection with last-good persistence and honest timestamp; Camo freshness is not guaranteed.
- Use supported cf operations, explicit targets, isolated stage resources and immutable release receipts.

## Review focus

- Partial pagination, duplicate entries or changing repository totals must not publish a partial total.
- Wrong authenticated account or restricted repository grant must not silently become public-only totals.
- Untrusted pagination URLs/redirects must never receive the GitHub token.
- GitHub/KV failure must preserve last-good counters and their original timestamp.
- Empty or malformed storage must show unavailable data, never plausible zero counters.

## Task 1: collector and SVG service

Files: src/profile.mjs, src/template.mjs, src/index.mjs, tests/profile.test.mjs, package.json.
Interfaces: collectStats(options) returns a validated aggregate; renderSvg(snapshot) preserves the current design; fetch serves GET/HEAD /terminal.svg without GitHub calls; scheduled refreshes the stored snapshot.

- [x] Write synthetic regression tests for the five review-focus conditions, pagination and private/fork totals.
- [x] Implement the bounded collector, complete-snapshot validation, rendering and handlers.
- [x] Run node --test and verify byte-equivalent non-stat visual content and no exposed secrets/private fields.

## Task 2: deployment and delivery

Files: cloudflare.config.ts, deployment resource registry/runbook, README.md, HANDOFF.md.

- [x] Inspect installed cf help/schema and existing account/resources; select isolated stage/prod names.
- [ ] Configure protected read-only GitHub access through an approved secret workflow; validate full owned-repo coverage.
- [x] Build both explicit modes from identical reviewed source; stage using synthetic values and no scheduler.
- [x] Verify built runtime, SVG headers, GET/HEAD, unavailable and last-good behavior; review exact candidate.
- [ ] Deploy production, initialize real aggregate and hourly refresh, read back bindings/schedule/version and verify endpoint.
- [ ] Update README image URL only after endpoint verification; inspect GitHub rendering.
- [ ] Commit/push normally, verify remote equality and clean tree; retain receipts and clean temporary resources.
