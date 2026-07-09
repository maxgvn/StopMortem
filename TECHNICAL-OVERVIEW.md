# Technical Overview

How StopMortem actually works, step by step: what calls what, which parts are Claude and which are plain code, and exactly how each "agent" is constructed. For what's real data vs. fabricated, see `DATA-SOURCES.md`. For file layout and dev commands, see `CLAUDE.md`. This page is the "how it runs" reference.

---

## The shape of the system in one sentence

Two separate Anthropic Messages API calls (not one continuous agent) connected by a persisted JSON object — Stage 1 gathers evidence via real tool calls, Stage 3 ranks and writes up the result — with an optional deterministic feedback step in between, everything numeric (scores, next-step categories) computed in plain JavaScript never by the LLM, and the whole thing decoupled from any single HTTP request so a run survives a browser navigating away.

```
Entry point (CLI, HTTP API, or simulated CRM webhook)
        │
        ▼
pipeline/run-registry.js  startRun({dealId, feedbackInput})
        │  generates a runId, returns it immediately, executes the promise below
        │  WITHOUT the caller awaiting it — see "Run registry" below
        ▼
pipeline/index.js  runPostMortem({ dealId, feedbackInput })
        │
        ├─ 1. getDeal(dealId)              → fixtures/index.js reads fixtures/deals/*.json
        ├─ 2. loadFramework('meddpicc')    → config/frameworks/index.js reads meddpicc.json
        ├─ 2b. loadFramework('pharma-compliance-addon') → only ACTIVATED if deal.meta.industry matches
        │
        ├─ 3. runStage1Evidence(deal, framework, addOnFramework)  [pipeline/stage1-evidence.js]
        │       → Claude Messages API, model claude-sonnet-5, tool-calling loop
        │       → real HTTP calls to Sillage (company-level) + FullEnrich (person-level)
        │       → parallel dispatch + in-run memoization of duplicate tool calls
        │       → returns a "deal portrait" (evidence, no conclusions), findings tagged by frameworkId
        │
        ├─ 4. reconcileFeedback(portrait, feedbackInput, activeFrameworks, deal)   [pipeline/feedback.js — "Stage 2"]
        │       → pure function, NO API call — skipped entirely if feedbackInput is null
        │
        ├─ 5. runStage3Scoring(finalPortrait)     [pipeline/stage3-scoring.js]
        │       → Claude Messages API, model claude-opus-4-8, single call, no tools
        │       → returns ranked causes, actions, department insights, next-steps rollup
        │
        └─ 6. finishAndPublish → publishLocalFile + buildPublishTargets
                → writes runs/<dealId>-<timestamp>/{portrait,postmortem}.json + report.md
                → attaches postmortem.publishTargets (local file = real, others = simulated)
```

A second, lighter path — `rerunWithFeedback({ portrait, feedbackInput })` — re-runs only steps 4–6 against an already-computed Stage 1 portrait. This is what manual feedback entry through the UI uses: it never repeats Stage 1's tool-calling loop or its Sillage/FullEnrich calls.

---

## Run registry — decoupled from any single HTTP request

**File:** `pipeline/run-registry.js`. Before this existed, `POST /api/deals/:id/run` awaited the entire pipeline inside the request handler — if the browser tab navigated away, the client-side fetch was abandoned and the UI lost all track of the run (the server kept running it, but nothing showed that). The registry fixes this structurally:

- `startRun({ dealId, feedbackInput, triggeredBy })` generates a `runId`, stores an entry (`{runId, dealId, status: "running", startedAt, result: null, error: null}`) in an in-memory `Map`, and calls `runPostMortem(...)` **without awaiting it** in the calling route — the promise's `.then()`/`.catch()` update the registry entry when it eventually settles. The function returns the `runId` synchronously.
- `startFeedbackRerun({ portrait, feedbackInput })` is the same pattern over `rerunWithFeedback(...)`.
- `getRun(runId)` and `getLatestRunForDeal(dealId)` are plain `Map` reads — polling endpoints, not agentic.

This is what makes three things possible at once: (1) the HTTP handler returns `202` immediately instead of blocking for 30-90s, (2) a webhook can trigger a run with no browser involved at all, (3) the frontend can navigate away and back and resume showing progress or the finished result by polling `GET /api/deals/:id/latest-run` — no client-side state (no `localStorage`) needed, since the server is the source of truth. Trade-off: the registry is in-memory and resets on server restart; the finished output still lands on disk via the writeback adapter regardless.

---

## Entry points

All roads lead to the run registry, which calls the same `runPostMortem()`:

| Entry point | File / route | Notes |
| --- | --- | --- |
| CLI | `scripts/run-demo.mjs` | `node scripts/run-demo.mjs --deal deal-005 [--feedback <path> \| --waive-feedback]`. Still runs synchronously (no registry) since there's no server/UI to keep in sync with. If neither flag is given, auto-loads `fixtures/feedback/<dealId>-feedback.json` if one exists. |
| HTTP API | `POST /api/deals/:id/run` | Body `{ waiveFeedback: boolean }`. Returns `202 {runId, status: "running"}` immediately. |
| Simulated CRM webhook | `POST /api/webhooks/deal-closed` | Body `{ dealId }`. Stands in for a real HubSpot "Closed Lost" workflow calling in — same registry call, tagged `triggeredBy: "crm_webhook"`. There is no real webhook receiver/signature verification here; it's a demonstration of the trigger shape, not a production endpoint. |
| Manual feedback (UI) | `POST /api/deals/:id/feedback` | Body `{ findings, collectedVia }`. Requires a completed run already in the registry for that deal; calls `startFeedbackRerun`, not `startRun` — skips Stage 1 entirely. |
| Poll | `GET /api/runs/:runId`, `GET /api/deals/:id/latest-run` | Plain registry reads. |
| Status | `GET /api/status` | Live connectivity check — Sillage via a lightweight Top Account List call, FullEnrich via `account/keys/verify`, HubSpot hardcoded `not_integrated`. Backs the sidebar's always-visible status strip. |

None of these routes do anything "agentic" themselves — they call into `pipeline/` and shape the response.

---

## Stage 1 — the evidence agent

**File:** `pipeline/stage1-evidence.js`. **Model:** `claude-sonnet-5`. **Call shape:** `client.messages.create({ model, max_tokens: 16000, thinking: { type: "adaptive" }, system, tools, messages })`, looped.

### How the "agent" is actually constructed

There is no separate agent object, no persistent session, no SDK abstraction beyond the plain Messages API. "The agent" is: a system prompt + a tool list + a `for` loop that keeps calling `client.messages.create` and feeding tool results back in, until Claude stops asking for tools. Concretely:

1. **Tool list** — the concatenation of `sillageToolDefinitions` (`lib/sillage/tools.js`) and `fullEnrichToolDefinitions` (`lib/fullenrich/tools.js`), passed as the `tools` array on every call. See the tool tables below for exactly what's in each.
2. **System prompt** — built once per run by `buildSystemPrompt(framework, addOnFramework)`. It:
   - States the agent's one job: build a complete evidence portrait, do NOT rank causes or propose actions (that's Stage 3).
   - Instructs it to treat the deal's `closedLostReason` as a claim to verify, not fact.
   - Tells it which tools exist and roughly when to reach for each (enrich the deal's company and competitors; resolve title-only stakeholders via `fullenrich_reverse_email` or `fullenrich_lookup_person`).
   - **Requires relevance-verification before citing Sillage's account/persona-level tools**, and **forbids fabricating tool attribution**: `sillage_workspace_signals`/`sillage_persona_context` results must actually concern the deal's own company before being used at all (a real bug during development: the account's persona is sometimes unrelated to the deal — see `DATA-SOURCES.md`), and `marketSignals` entries may never be prefixed with a tool's name unless that exact tool call produced that content this session — a real bug caught in testing was the model restating the deal's own `identifyPain` field as if FullEnrich/Sillage had supplied it externally.
   - **Forbids redundant identical tool calls** ("call each distinct tool+input combination AT MOST ONCE per session") — backed by the in-run memoization described below, not just the prompt instruction alone.
   - Injects the primary framework's gap-scan instructions (`buildGapScanInstructions`) and, if an add-on framework is active for this deal's industry, a second independent set of instructions (`buildAddOnInstructions`) — see "Swappable frameworks" below.
   - Specifies the exact JSON shape the final answer must match (schema in `pipeline/schemas/deal-portrait.schema.json`), including the deterministic finding-ID convention `<dealId>-<dimension>` (e.g. `deal-003-competition`) — chosen specifically so feedback can reference a finding *before* Stage 1 has ever run.
3. **First user message** — the entire fixture deal JSON, verbatim, prefixed with "build the evidence portrait."
4. **The loop** (`for (let i = 0; i < MAX_ITERATIONS; i++)`, `MAX_ITERATIONS = 12`):
   - Call `client.messages.create(...)`.
   - Append the assistant's response to `messages`.
   - If `stop_reason !== "tool_use"` (or there are no `tool_use` blocks), the loop is done — the response's `text` block is the final answer, expected to be raw JSON.
   - Otherwise, **every `tool_use` block in this turn is dispatched concurrently via `Promise.all`** — Claude can request several independent lookups in one response, and there's no reason to serialize them. Before dispatching, each call is checked against an in-run `Map` keyed by `` `${toolName}:${JSON.stringify(input)}` `` — an identical call within the same run returns the cached result instead of repeating the HTTP request. (This fixed a confirmed real issue: one early run called `fullenrich_reverse_email` with the same email 4 times and another email 2 times — pure waste, now eliminated.) Every call — cached, fresh, or errored — is appended to `toolCallLog`.
   - Loop again with the updated `messages` array.
5. **Parsing the final answer** — `extractJson()` (`pipeline/util.js`) strips a leading/trailing markdown code fence if present, then `JSON.parse`s it. If Claude hits `max_tokens` before finishing, this throws a specific error (a real bug during development — the model was asked to embed full raw enrichment dumps, which blew the budget; fixed by instructing it to summarize enrichment into a few fields and raising `max_tokens` to 16000).
6. **Post-processing** (plain code, after Claude is done talking):
   - `validateGapFindings(findings, activeFrameworks)` — throws if any finding references a `dimension` not in *any* active framework's dimension list (primary + add-on, if applicable).
   - `tagFindingsWithFramework(findings, activeFrameworks)` — deterministically resolves which framework actually owns each finding's dimension and attaches `frameworkId` accordingly. The LLM never has to get this right itself; it's derived from a reverse lookup.
   - `classifyNextStep(finding, deal.deal)` for every finding.
   - `scoreAllFindings(findings, activeFrameworks)` — attaches a `score`, looking up each dimension's `causalWeightHint` across whichever framework (primary or add-on) actually contains it.

So: Claude decides *what the findings are*, *which evidence tier they're in*, *what citations support them*, and *what tools to call and when*. Code decides *which framework a finding belongs to*, *the next-step category*, and *the numeric score* — all deterministically, from config.

### Swappable frameworks — demonstrated, not just architected (`pipeline/gap-scan.js`)

MEDDPICC (`config/frameworks/meddpicc.json`) is the primary framework for every deal. A **second, independent add-on framework** — `config/frameworks/pharma-compliance-addon.json` (21 CFR Part 11 compliance, data residency, validation documentation, formal security sign-off) — activates only when a deal's fixture sets `meta.industry: "life_sciences_pharma"` (checked via `appliesToIndustry(addOnFramework, deal.meta.industry)`). Currently only the Medidata Solutions fixture (`deal-003`) sets this. When active:

- `buildAddOnInstructions(addOnFramework)` appends a second, clearly-separated gap-scan pass to the system prompt, using the exact same evidence-tier rules and finding-id convention as the primary scan.
- `validateGapFindings` and `scoreAllFindings` both accept an *array* of frameworks (`[framework, addOnFramework]`) and search across all of them for a matching dimension key — this works because the two frameworks' dimension keys never collide (`economicBuyer` vs. `cfr11Compliance`, etc.), so no explicit namespacing was needed.
- `tagFindingsWithFramework` labels each finding with the id of whichever framework actually owns its dimension, and the frontend uses that tag (`p.addOnFramework && f.frameworkId === p.addOnFramework.id`) to render add-on findings in a visually distinct section rather than mixing them into the core list.

Nothing in `gap-scan.js`, `rubric-scoring.js`, or `next-step-classifier.js` imports a specific framework file — they only ever take framework objects as parameters. Swapping in a third framework for a different industry is a new JSON file plus a check in `pipeline/index.js`'s `resolveActiveFrameworks`, not a pipeline code change.

### Sillage tools (`lib/sillage/tools.js` + `lib/sillage/client.js`)

Base URL `https://api.getsillage.com`. Auth: `Authorization: Bearer <SILLAGE_API_KEY>`. Path prefix is `/api/v2/...` for most endpoints and `/api/v1/...` for workspace-scoped ones — confirmed empirically during development; the raw OpenAPI spec's bare `/v2/...` paths are wrong for the live host. **Sillage does company-level enrichment only — it has no way to resolve an individual person.**

| Tool Claude sees | What it actually does |
| --- | --- |
| `sillage_enrich_company` | `POST /api/v2/top-account-list/accounts` (add the domain/LinkedIn URL) → poll `GET /api/v2/top-account-list/status` (up to 15s, every 1.5s) until `state` is `completed`/`failed` → `GET /api/v2/top-account-list/accounts` and find the matching entry. One Claude-visible tool call hides three real HTTP requests. |
| `sillage_check_not_found` | `GET /api/v2/top-account-list/accounts/not-found` |
| `sillage_workspace_signals` | `GET /api/v1/workspace/signals` |
| `sillage_persona_context` | `GET /api/v2/persona` — read-only; `PUT /persona` is never called from the pipeline (it was used once, manually, during setup, to expand the account's persona — see `DATA-SOURCES.md`) |

`sillage_workspace_signals` and `sillage_persona_context` are deliberately not treated as authoritative in the system prompt — the account's persona/signals aren't reliably scoped to any one deal's industry (a real, observed issue — see `DATA-SOURCES.md`), so the agent is required to verify relevance before using anything from either tool, and forbidden from attributing `marketSignals` content to a tool call that didn't actually happen.

### FullEnrich tools (`lib/fullenrich/tools.js` + `lib/fullenrich/client.js`)

Base URL `https://app.fullenrich.com/api/v2`. Auth: `Authorization: Bearer <FULLENRICH_API_KEY>`. **This is the person-level resolution layer** — anywhere the deal's evidence names a stakeholder only by title, FullEnrich (not Sillage) is how the agent tries to find out who they actually are.

| Tool Claude sees | What it actually does |
| --- | --- |
| `fullenrich_lookup_company` | `POST /company/lookup` — sync, one call |
| `fullenrich_lookup_person` | `POST /people/lookup` with `person_name` + `company_domain` (or `person_professional_network_url`) — sync. **These exact field names matter**: FullEnrich's own error messages during testing revealed the real field names (`person_name`, not `full_name`; `person_professional_network_url`, not `professional_network_url`) — the public docs had them wrong. |
| `fullenrich_search_companies` | `POST /company/search` with `domains`/`industries`/`specialties` — each converted to FullEnrich's real wire format, an array of `{value: "..."}` objects (`apiv2.StringFilters` in their backend's own error messages), not a plain string array. Confirmed by deliberately sending wrong types and reading the resulting Go unmarshal errors. |
| `fullenrich_reverse_email` | `POST /contact/reverse/email/bulk` (submit) → poll `GET /contact/reverse/email/bulk/{enrichment_id}` (up to 30s, every 2s) until `status` is no longer `IN_PROGRESS`. Note the submit response's ID field is `enrichment_id`, not `id`. |
| `fullenrich_enrich_contact` | Same submit-then-poll pattern against `/contact/enrich/bulk`. |

**Not wired in:** `people/search` (bulk filter-by-seniority search). Its request schema is undocumented and, unlike `company/search`, never produced a type error under `~25` different field-name/shape guesses during testing — no signal to work from. Dropped rather than shipped guessing. This is why stakeholder resolution leans on `lookup_person` (you need a name) and `reverse_email` (you need an email address seen in the fixture's `emails[]`) instead of a seniority-filtered search.

---

## Stage 2 — Follow-up / Feedback (optional, waivable, no API call at all)

**File:** `pipeline/feedback.js`. This is the one "stage" that never touches the network. `reconcileFeedback(portrait, feedbackInput, activeFrameworks, deal)`:

1. For each finding in the portrait, look up `feedbackInput.findings[finding.id]` (keyed by the deterministic `<dealId>-<dimension>` ID).
2. If present and `clientConfirms: true`: upgrade `evidenceTier` to `documented_gap` (or `evidence_conflict` if `clientDisputes: true` too — a partial confirmation), bump `confidence` to `0.95`, and append a `{ source: "client_feedback", ... }` citation with the feedback's `note` text.
3. Findings with no matching feedback entry are returned completely unchanged — "inferred hypotheses are never actioned until confirmed" is a structural guarantee, not a prompting convention.
4. Every updated finding is re-run through `classifyNextStep` and `scoreAllFindings` (same deterministic functions Stage 1 used, now against `activeFrameworks` so an add-on-framework finding's causal weight still resolves correctly).

Two ways feedback reaches this function:

- **Fixture-driven** — `fixtures/feedback/<dealId>-feedback.json`, auto-loaded by the CLI/API unless waived. Runs as part of the same `runPostMortem()` call as Stage 1.
- **Manually entered via the UI** — the Stage 2 tab's form lets a user pick any still-`inferred_hypothesis` finding, choose confirm/partial-confirm/note-only, and type what was actually said. Multiple entries can be staged client-side (`manualEntries[]` in `app.js`) before submitting. Submission calls `POST /api/deals/:id/feedback`, which invokes `rerunWithFeedback({ portrait, feedbackInput })` — this re-runs **only** `reconcileFeedback` + Stage 3 against the deal's most recently completed Stage 1 portrait (fetched from the run registry), never repeating Stage 1's tool-calling loop or its Sillage/FullEnrich calls. This is why manual feedback entry is fast (one Claude call) compared to a full run.

If `feedbackInput` is falsy (waived, no fixture, no manual entry yet), `reconcileFeedback` isn't even called — the portrait passes straight through to Stage 3 unchanged.

---

## Stage 3 — the scoring/synthesis agent

**File:** `pipeline/stage3-scoring.js`. **Model:** `claude-opus-4-8`. **Call shape:** a single, non-looping `client.messages.create({ model, max_tokens: 4000, thinking: { type: "adaptive", display: "summarized" }, system, messages })` — no `tools` at all. Opus 4.8 doesn't default to thinking-on when the field is omitted, so it's set explicitly; `display: "summarized"` surfaces the reasoning trace rather than an empty `thinking` block.

**Before the API call**, plain code does the ranking-relevant work:
- Filters `finalPortrait.gapFindings` into `nonSpeculative` (tier ≠ `inferred_hypothesis`) and `speculative` (tier = `inferred_hypothesis`).
- Sorts `nonSpeculative` by `score` descending — **this is the actual rank order**, computed in code, not by Claude.

**The prompt explicitly forbids Claude from recomputing scores** and from proposing actions sourced from `speculative` findings. What Claude is asked to do:
1. Write a 2-4 sentence summary of why the deal was likely lost.
2. For each non-speculative finding (in the pre-sorted order), write a one-paragraph explanation citing its attached evidence.
3. Propose remedial actions grouped by category, sourced only from non-speculative findings.
4. Write department-specific takeaways for exactly three internal departments — Sales, Pre-Sales, Product — 1-2 sentences each, or an explicit "no specific action for this team" rather than invented filler.
5. Optionally, one sentence on whether the account might realistically be re-engaged later — only if the evidence genuinely supports it, `null` otherwise. This is the entire "rescue" surface in the product; deliberately not a plan (see `README.md` → Guardrails on why rescue is out of scope).

**After the API call**, more plain code:
- `buildNextStepsRollup(gapFindings)` groups every finding (not just the ranked ones) by `recommendedNextStepCategory` into a fixed 4-bucket object — the "what happens next" view the UI renders prominently, instead of leaving next-step categories buried as a per-finding badge only.
- Back in `pipeline/index.js`, `finishAndPublish` calls `publishLocalFile` (the real write) and then `buildPublishTargets` (`output/publish-targets.js`) — a deterministic, code-generated list of where the report was/would be distributed. Only `{target: "Local file", simulated: false}` reflects something that actually happened; HubSpot/Slack/Notion entries are `simulated: true` with a `detail` string describing what a real integration would do — never presented as though they're actually connected.

Response is parsed the same way as Stage 1 (`extractJson`). **Verified in practice:** every run has produced `postmortem.rankedCauses[].score` values byte-identical to `portrait.gapFindings[].score` for the same finding ID — Stage 3 genuinely passes the numbers through rather than drifting.

---

## The deterministic layer — what's code, not LLM

### Next-step classification (`pipeline/next-step-classifier.js`)

Reads `config/next-step-thresholds.json`. Pure function `classifyNextStep(finding, deal, thresholds)`:

```
dealIsBigEnough      = deal.amount >= thirdPartyReview.minDealAmount            (75000)
pipelineIsDeepEnough = deal.pipelineStagesReached ∩ thirdPartyReview.minPipelineStagesReached ≠ ∅
                                                                                  (["proposal_sent","negotiation"])
tripsThirdPartyReview = dealIsBigEnough AND pipelineIsDeepEnough   (requireBothConditions: true)

if tripsThirdPartyReview:                                          → full_third_party_review
else if evidenceTier == documented_gap AND confidence > 0.6:        → no_further_investigation_needed
else if confidence <= 0.6 (ambiguityConfidenceCeiling):             → client_call_needed
else:                                                                → some_internal_followup_needed
```

`tripsThirdPartyReview` is a **deal-level** condition — if it fires, every finding on that deal gets `full_third_party_review`, regardless of that finding's own tier or confidence. This is intentional: a large, far-along deal warrants a full review of the whole loss, not a per-finding judgment call.

### Scoring rubric (`pipeline/rubric-scoring.js`)

> Renamed from `scoring.js` — the old name collided with `stage3-scoring.js` in the same directory and was a real source of confusion (flagged externally during review). The formula itself was unchanged; only the filename and its callers were.

Reads `config/scoring-rubric.json`. Pure function `scoreFinding(finding, frameworks, rubric)` — `frameworks` may be a single framework or an array (primary + any active add-on):

```
tierWeight        = rubric.tierWeights[finding.evidenceTier]
                       documented_gap: 1.0 | evidence_conflict: 0.7 | inferred_hypothesis: 0.3
causalWeight       = findDimension(finding.dimension, frameworkList).causalWeightHint   (searches ALL active frameworks; falls back to 0.5)
corroborationBonus = min( max(citationCount - 1, 0) * 0.08 , 0.3 )

score = round( (tierWeight * causalWeight) + corroborationBonus , 3 decimal places )
```

Note the operator precedence explicitly: it's `(tierWeight × causalWeight) + corroborationBonus` — multiplication between tier and causal weight, then the corroboration bonus is *added* on top, never multiplied in. (An earlier draft of `README.md` stated this inconsistently in two places — one said all-multiplication — and was corrected to match this actual formula.)

`causalWeightHint` is per-dimension in each framework's JSON — e.g. MEDDPICC's `economicBuyer` is weighted `0.95` (missing the actual budget holder is close to maximally damaging), `paperProcess` is `0.4`; the pharma add-on's `cfr11Compliance` is `0.8`.

---

## Data layer

`fixtures/index.js` exports `listDeals()`, `getDeal(id)`, `getFeedback(id)` — reading straight from `fixtures/deals/*.json` and `fixtures/feedback/*.json`. This is the entire "CRM" as far as the pipeline is concerned; there is no HubSpot API call anywhere in this codebase. `meta.industry` on a deal fixture (currently only `"life_sciences_pharma"` on `deal-003`) is what conditionally activates the pharma compliance add-on framework. See `DATA-SOURCES.md` for exactly which parts of each fixture are real companies/enrichable data vs. fabricated deal narrative.

---

## Output layer

`output/writeback/local-file-adapter.js`'s `publish(postmortem, portrait)` writes three files per run to `runs/<dealId>-<timestamp>/` (gitignored): `portrait.json`, `postmortem.json`, and `report.md` (rendered by `output/render-markdown.js` — includes the next-steps rollup, department insights, recovery note, and publish-targets sections, grouped-by-category actions). `output/writeback/hubspot-adapter.stub.js` documents the same `publish()` contract for a future real CRM writeback — not implemented, throws if called. `output/publish-targets.js` is the deterministic builder for `postmortem.publishTargets` — see Stage 3 above.

---

## Frontend (`public/index.html`, `style.css`, `app.js`)

Plain HTML/CSS/vanilla JS, no build step, no framework.

- On load, `app.js` calls `GET /api/deals` (which now includes each deal's `activeRun` status) and renders the left sidebar; a `setInterval` refreshes it every 4s so a run triggered on another deal (e.g. via the simulated webhook) still shows a live "Running" indicator with a pulsing dot.
- Clicking a deal calls `GET /api/deals/:id` for the raw fixture, then `GET /api/deals/:id/latest-run` — if a run for this deal is already `running`, it resumes polling; if `completed`, it shows the cached result immediately; if `error`, it shows the error. This is what makes navigating away and back not lose a run.
- Clicking "Run post-mortem" (or "Simulate CRM auto-trigger") calls the corresponding `POST` route, gets a `runId` back immediately, and starts polling `GET /api/runs/:runId` every 1.8s. A persistent, hard-to-miss banner (spinner + text) stays visible for the entire running period — not a small status line that could be missed given the real latency involved.
- Once a result exists, the deal view renders three **tabs** (not one long scroll) mirroring the pipeline's stages: Evidence Portrait / Follow-up / Synthesis. Long lists (gap findings, ranked causes) are capped to the top 5 by score with the remainder behind a `<details>` fold-out, rather than dumping an unbounded list.
- The Follow-up tab includes the manual feedback entry form described in Stage 2 above, plus (when applicable) the before→after tier diff for feedback that was already applied.
- The Synthesis tab includes the next-steps rollup (grouped counts, not just per-finding badges), remedial actions grouped by category, department-specific takeaways, the optional recovery note, and the "Published to" list (real vs. simulated targets, clearly marked).
- Evidence-tier findings from the pharma compliance add-on (when active) render in a visually distinct section (violet-accented, a categorical identity marker rather than a status color) — never mixed into the core MEDDPICC findings, never shown for a non-pharma deal.
- Evidence-tier and next-step badges use a fixed, non-thematic status palette (good/warning/serious/critical) mapped as: `documented_gap`→good, `evidence_conflict`→warning, `inferred_hypothesis`→muted (no status color — it's not "bad," just unconfirmed); `no_further_investigation_needed`→good, `some_internal_followup_needed`→warning, `client_call_needed`→serious, `full_third_party_review`→critical.
- A status strip at the bottom of the sidebar (`GET /api/status`, refreshed every 20s) always shows Sillage/FullEnrich/HubSpot connectivity — a read-only connectivity readout, not an admin/config surface.

---

## Environment variables

| Variable | Used by |
| --- | --- |
| `ANTHROPIC_API_KEY` | `lib/anthropic/client.js` — both Stage 1 and Stage 3 |
| `SILLAGE_API_KEY`, `SILLAGE_API_BASE` | `lib/sillage/client.js` |
| `FULLENRICH_API_KEY`, `FULLENRICH_API_BASE` | `lib/fullenrich/client.js` |

No other network calls exist anywhere in the pipeline.
