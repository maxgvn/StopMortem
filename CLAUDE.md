# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

StopMortem — turns a lost sales deal into a scored, evidence-backed post-mortem with reusable corrective actions. Node/Express + a plain HTML frontend (no build step, no frontend framework), runs locally on `localhost:3000`. See `README.md` for the product vision, `TECHNICAL-OVERVIEW.md` for a step-by-step technical walkthrough, and `DATA-SOURCES.md` for what's real vs. fabricated.

## Commands

- `npm install` — install dependencies
- `npm run dev` — start the Express server via nodemon
- `npm start` — start the Express server directly
- `node scripts/run-demo.mjs --deal <dealId> [--feedback <path> | --waive-feedback]` — run the full pipeline from the CLI against a fixture deal (e.g. `--deal deal-005`)
- `node scripts/smoke-test.mjs` — quick live sanity check of the Sillage/FullEnrich REST clients

There is no test suite, lint config, or build step at this stage.

## Environment

Copy `.env.example` to `.env` and fill in real values (`.env` is gitignored):

- `ANTHROPIC_API_KEY` — Anthropic Messages API
- `SILLAGE_API_KEY`, `SILLAGE_API_BASE` (default `https://api.getsillage.com`) — company enrichment
- `FULLENRICH_API_KEY`, `FULLENRICH_API_BASE` (default `https://app.fullenrich.com/api/v2`) — company/person enrichment

## Architecture

**Two-stage pipeline, connected by a persisted JSON contract, decoupled from the HTTP request lifecycle.** `pipeline/run-registry.js` starts a run and returns a `runId` immediately — the run keeps executing server-side regardless of whether the client that started it is still connected. `pipeline/index.js` (`runPostMortem`, `rerunWithFeedback`) is the actual orchestration logic the registry calls:

1. **Stage 1 — `pipeline/stage1-evidence.js`** (`claude-sonnet-5`, tool-calling loop). Given a fixture deal (`fixtures/deals/*.json` — a fake HubSpot export), builds a complete evidence "deal portrait": a stakeholder map, competitive context, and gap findings tagged by evidence tier (`documented_gap` / `evidence_conflict` / `inferred_hypothesis`), using **real, live** tool calls to Sillage (company-level) and FullEnrich (person-level) — see `lib/sillage/`, `lib/fullenrich/`. Same-key tool calls (identical tool + args) are memoized within a run and dispatched in parallel per turn — Claude's tool_use blocks in one response are never serialized needlessly. This stage never ranks causes or proposes actions — only Stage 3 does that.
2. **Stage 2 — `pipeline/feedback.js`** (optional, waivable). A pure transform, no LLM call: upgrades referenced `inferred_hypothesis` findings to confirmed tiers by finding ID (`<dealId>-<dimension>`, assigned deterministically by Stage 1 so feedback can reference them ahead of time). Untouched findings are left as-is. Two ways feedback reaches it: a `fixtures/feedback/<dealId>-feedback.json` fixture (auto-loaded unless `--waive-feedback`), or a manual entry via `POST /api/deals/:id/feedback` (the UI's Stage 2 tab form) — the latter calls `pipeline/index.js`'s `rerunWithFeedback()`, which re-runs **only** Stage 2 + Stage 3 against the already-computed Stage 1 portrait, never repeating the tool-calling loop or its Sillage/FullEnrich calls.
3. **Stage 3 — `pipeline/stage3-scoring.js`** (`claude-opus-4-8`, single call). Ranks non-speculative findings using a rubric score computed **deterministically in code** (`pipeline/rubric-scoring.js`, `config/scoring-rubric.json` — evidence tier weight × causal weight, then + a corroboration bonus; the LLM narrates/cites against these numbers, it doesn't invent them), proposes remedial actions by category, and writes department-specific takeaways (Sales / Pre-Sales / Product). `inferred_hypothesis` findings are passed through as `speculativeHypotheses` and never turned into actions — enforced in code, not just prompted. Also attaches a deterministic `nextStepsRollup` (every finding grouped by next-step category — the "what happens next" view, not just a per-finding badge) and `publishTargets` (`output/publish-targets.js` — where the report was/would be distributed; only "Local file" is real, others are explicitly marked simulated).

The "recommended next-step category" per finding (`no_further_investigation_needed` / `some_internal_followup_needed` / `client_call_needed` / `full_third_party_review`) is computed deterministically (`pipeline/next-step-classifier.js`, thresholds in `config/next-step-thresholds.json`) — not decided by the LLM.

**The qualification framework is swappable, not hardcoded — and this is demonstrated, not just architected.** MEDDPICC (`config/frameworks/meddpicc.json`) is the primary/demo instance; `pipeline/gap-scan.js`, `rubric-scoring.js`, and `next-step-classifier.js` only ever operate on framework objects passed in — never import a specific framework file. A **second, independent add-on framework** (`config/frameworks/pharma-compliance-addon.json`) proves this: it activates only when a deal's fixture sets `meta.industry: "life_sciences_pharma"` (see `gap-scan.js`'s `appliesToIndustry`), runs as a genuinely separate gap-scan pass, and its findings are tagged with their own `frameworkId` (via `tagFindingsWithFramework`) so the UI can render them in a visually distinct section rather than mixing them into the core MEDDPICC findings.

**Output** lands in `runs/<runId>/` via `output/writeback/local-file-adapter.js` (JSON + rendered Markdown). `output/writeback/hubspot-adapter.stub.js` documents the not-yet-built real integration behind the same adapter contract (`output/writeback/interface.js`) — `output/publish-targets.js` is what the report claims about *where* it published, and only the local-file entry is backed by that stub actually running.

### Run registry, webhook trigger, and status endpoints (`routes/api.js`)

- `POST /api/deals/:id/run` — starts a run, responds `202` with `{runId}` immediately (does not await the pipeline).
- `POST /api/webhooks/deal-closed` — same shape, simulates a CRM "Closed Lost" workflow auto-triggering a run (`triggeredBy: "crm_webhook"` in the registry entry) — there's no real HubSpot webhook receiver, this is what stands in for one.
- `POST /api/deals/:id/feedback` — manual feedback entry from the UI; requires a completed run for that deal already in the registry, calls `rerunWithFeedback`.
- `GET /api/runs/:runId` — poll for status/result.
- `GET /api/deals/:id/latest-run` — lets the UI resume showing an in-progress or completed run after navigating away and back, without any client-side persistence.
- `GET /api/status` — live connectivity check (Sillage via a lightweight Top Account List call, FullEnrich via `account/keys/verify`; HubSpot always reports `not_integrated`) — backs the sidebar's always-visible status strip. Not an admin/config surface, just a read-only connectivity readout.

### HubSpot is fully faked; Sillage and FullEnrich are real

There is no HubSpot integration. `fixtures/deals/*.json` are fake CRM exports standing in for it — see `fixtures/index.js` (`listDeals`, `getDeal`, `getFeedback`). Sillage and FullEnrich, by contrast, are real, live REST integrations (`lib/sillage/client.js`, `lib/fullenrich/client.js`) exercised by real tool calls during Stage 1 — not mocked. See `DATA-SOURCES.md` for the full real-vs-fake breakdown per fixture.

Things worth knowing if touching these clients:
- **Sillage does company-level enrichment only — it cannot resolve individual people.** Person-level resolution (named lookup, reverse-email) is FullEnrich's job. Don't conflate the two when editing prompts or tool descriptions (this was a real bug — the README used to imply Sillage did "stakeholder identification").
- **Sillage's path prefix is `/api/v2/...` / `/api/v1/...`**, not the bare `/v2/...` the raw OpenAPI spec implies — confirmed empirically. Sillage's `GET /persona` has also proven unreliable to read on the shared demo account this was built against (returns different, unrelated personas across consecutive calls) — writes (`PUT /persona`, Top Account List add) have been more consistent, but don't assume a `GET` after a write reflects it. Because of this, Stage 1's prompt requires verifying that any `sillage_workspace_signals`/`sillage_persona_context` result actually concerns the deal's own company before citing it — and separately, forbids ever attributing `marketSignals` content to a tool unless a real tool call in that session produced it (a real bug: the model was once caught restating the deal's own `identifyPain` field as if it were an externally-sourced "Sillage" signal).
- **FullEnrich's `people/search`** has an undocumented request wire format (`company/search` uses typed `StringFilters` arrays of `{value}`; `people/search` doesn't respond to the same shape or to type-probing) and is **not wired into the tool set** — `fullenrich_lookup_person` (name + company domain) and `fullenrich_reverse_email` (email → identity) are the working paths for resolving a stakeholder known only by title.

### Sillage MCP vs. REST

Sillage's MCP server requires an interactive OAuth 2.1 browser login, which the Messages API's `mcp_servers.authorization_token` field can't perform (it only accepts a token already in hand). Direct MCP access is therefore a separate, Claude-Code-only exploration/setup channel (`claude mcp add --transport http sillage ...`), independent of this repo's REST-based pipeline code.
