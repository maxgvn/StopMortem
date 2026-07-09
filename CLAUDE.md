# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

StopMortem — turns a lost sales deal into a scored, evidence-backed post-mortem with reusable corrective actions. Node/Express + a plain HTML frontend (no build step, no frontend framework), runs locally on `localhost:3000`. See `README.md` for the product vision and `/Users/mghome/.claude/plans/enchanted-seeking-cat.md` for the v1 implementation plan.

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

**Two-stage pipeline, connected by a persisted JSON contract.** `pipeline/index.js` (`runPostMortem`) orchestrates:

1. **Stage 1 — `pipeline/stage1-evidence.js`** (`claude-sonnet-5`, tool-calling loop). Given a fixture deal (`fixtures/deals/*.json` — a fake HubSpot export), builds a complete evidence "deal portrait": a stakeholder map, competitive context, and gap findings tagged by evidence tier (`documented_gap` / `evidence_conflict` / `inferred_hypothesis`), using **real, live** tool calls to Sillage and FullEnrich (`lib/sillage/`, `lib/fullenrich/`). This stage never ranks causes or proposes actions — only Stage 3 does that.
2. **Feedback (optional)** — `pipeline/feedback.js`. A pure transform: if a `fixtures/feedback/<dealId>-feedback.json` exists (or one is passed explicitly), it upgrades referenced `inferred_hypothesis` findings to confirmed tiers by finding ID (`<dealId>-<dimension>`, assigned deterministically by Stage 1 so feedback fixtures can reference them ahead of time). Untouched findings are left as-is. Waivable via `--waive-feedback` / omitting `feedbackInput`.
3. **Stage 3 — `pipeline/stage3-scoring.js`** (`claude-opus-4-8`, single call). Ranks non-speculative findings using a rubric score computed **deterministically in code** (`pipeline/scoring.js`, `config/scoring-rubric.json` — evidence tier weight × causal weight + corroboration bonus; the LLM narrates/cites against these numbers, it doesn't invent them), and proposes remedial actions by category. `inferred_hypothesis` findings are passed through as `speculativeHypotheses` and never turned into actions — enforced in code, not just prompted.

The "recommended next-step category" per finding (`no_further_investigation_needed` / `some_internal_followup_needed` / `client_call_needed` / `full_third_party_review`) is also computed deterministically (`pipeline/next-step-classifier.js`, thresholds in `config/next-step-thresholds.json`) — not decided by the LLM.

**The qualification framework is swappable, not hardcoded.** MEDDPICC (`config/frameworks/meddpicc.json`) is the demo instance; `pipeline/gap-scan.js` and `next-step-classifier.js` only ever operate on a framework object passed in — never import a specific framework file — so a different framework is a config change.

**Output** lands in `runs/<runId>/` via `output/writeback/local-file-adapter.js` (JSON + rendered Markdown). `output/writeback/hubspot-adapter.stub.js` documents the not-yet-built real integration behind the same adapter contract (`output/writeback/interface.js`).

### HubSpot is fully faked; Sillage and FullEnrich are real

There is no HubSpot integration. `fixtures/deals/*.json` are fake CRM exports standing in for it — see `fixtures/index.js` (`listDeals`, `getDeal`, `getFeedback`). Sillage and FullEnrich, by contrast, are real, live REST integrations (`lib/sillage/client.js`, `lib/fullenrich/client.js`) exercised by real tool calls during Stage 1 — not mocked.

Two things worth knowing if touching these clients:
- **Sillage's path prefix is `/api/v2/...` / `/api/v1/...`**, not the bare `/v2/...` the raw OpenAPI spec implies — confirmed empirically. Sillage's `GET /persona` has also proven unreliable to read on the shared demo account this was built against (returns different, unrelated personas across consecutive calls) — writes (`PUT /persona`, Top Account List add) have been more consistent, but don't assume a `GET` after a write reflects it.
- **FullEnrich's `people/search`** has an undocumented request wire format (`company/search` uses typed `StringFilters` arrays of `{value}`; `people/search` doesn't respond to the same shape or to type-probing) and is **not wired into the tool set** — `fullenrich_lookup_person` (name + company domain) and `fullenrich_reverse_email` (email → identity) are the working paths for resolving a stakeholder known only by title.

### Sillage MCP vs. REST

Sillage's MCP server requires an interactive OAuth 2.1 browser login, which the Messages API's `mcp_servers.authorization_token` field can't perform (it only accepts a token already in hand). Direct MCP access is therefore a separate, Claude-Code-only exploration/setup channel (`claude mcp add --transport http sillage ...`), independent of this repo's REST-based pipeline code.
