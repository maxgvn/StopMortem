# What's real and what's fake in this demo

StopMortem mixes real, live API calls with entirely fabricated deal data. This page is the map — read it before treating anything the UI shows as fact.

## External integrations

| Integration | Status | Detail |
| --- | --- | --- |
| **Anthropic Claude API** | Real | Every Stage 1 and Stage 3 call is a genuine Messages API request. Nothing about the LLM output is mocked. |
| **Sillage** | Real | `lib/sillage/`. Live REST calls against `api.getsillage.com` with a real API key — company enrichment via the Top Account List, workspace signals, persona lookup. Medidata Solutions (`mdsol.com`/`medidata.com`) and Box (`box.com`) were added to the **real, live** Top Account List on this account during development. The persona on that account was also genuinely expanded (via `PUT /persona`) to include IT-buyer and architect titles alongside the existing clinical-ops titles. **Caveat:** `GET /persona` proved unreliable to read back on this account — it returned different, unrelated personas across consecutive calls, apparently a scoping issue on Sillage's side on the shared account this was built against. Writes are more trustworthy than reads for that specific endpoint. |
| **FullEnrich** | Real | `lib/fullenrich/`. Live REST calls against `app.fullenrich.com/api/v2` with a real API key — company lookup, named-person lookup, company search, reverse-email lookup. Every enrichment result shown in the UI is genuine, current data (e.g. GitLab's real data correctly shows Sid Sijbrandij stepped down as CEO in Dec 2024 — the fixture below is stale on this point, and the *agent's own analysis* correctly caught and noted the discrepancy). **Caveat:** `people/search` (filter-by-seniority bulk search) has an undocumented request wire format that didn't respond to extensive testing — it is not wired in. Stakeholder resolution instead relies on `lookup_person` (name + company domain) and `reverse_email` (email → identity), both confirmed working. |
| **HubSpot / CRM** | **Fully fake** | Not integrated at all. Every "deal" is a local JSON fixture (`fixtures/deals/*.json`) standing in for a HubSpot export. See below for exactly what's fabricated. |

## Fixture deals — real vs. invented, per deal

Every fixture pairs a **real company** (so live enrichment calls return genuine data) with an **entirely invented sales narrative** (deal amount, stage, notes, activity timeline, emails, proposal terms, closed-lost reason). The company is real; the deal never happened.

| Fixture | Real | Invented |
| --- | --- | --- |
| `deal-001` (Box) | Company: Box (`box.com`). One anchor stakeholder, Aaron Levie (real CEO, used only as an enrichment test target — never actually "in" the fabricated deal). | Deal amount, stage, all notes/activity/emails/proposal. The "IT Director" stakeholder is a title-only placeholder — no real name, by design (the gap the deal is built to demonstrate). |
| `deal-002` (Asana) | Company: Asana (`asana.com`). Anchor stakeholder: Dustin Moskovitz (real co-founder/CEO, same caveat as above). | Deal narrative, budget-conflict story, "VP Operations" title-only placeholder, named competitor Rippling (real company, fictional competitive mention). |
| `deal-003` (Medidata Solutions) | Company: Medidata Solutions (`medidata.com`) — **the actual target account for this demo**, per your direction. Named competitor Veeva Vault CTMS (real company). | Deal narrative, all stakeholders are title-only placeholders (Chief Medical Officer, VP Clinical Development, IT Director — no real names), the feedback fixture's "Veeva renewal discount" story. |
| `deal-004` (Datadog) | Company: Datadog (`datadoghq.com`). Anchor stakeholder: Olivier Pomel (real co-founder/CEO, enrichment-test-only). Named competitor Vanta (real company). | Deal narrative, budget-freeze story, "VP Security & Compliance" / "Compliance Manager" title-only placeholders. |
| `deal-005` (GitLab) | Company: GitLab (`gitlab.com`). Anchor stakeholder: Sid Sijbrandij (real founder — see the caveat above about his current real title being out of date in this fixture). | Deal narrative, budget-cut story, "Engineering Manager" title-only placeholder. |

**Why title-only placeholders matter:** stakeholders known only by title, with no name in the "CRM," are not a shortcut — they're the intended gap. Stage 1's job includes trying to resolve who actually holds that title via FullEnrich's `reverse_email` (using a synthetic email address seeded in the fixture's `emails[]`) or `lookup_person`. Whether it succeeds or returns "not found" is itself real signal about enrichment coverage, not scripted.

**The `deal-003-feedback.json` fixture** is entirely invented (a fabricated quote from "the VP Clinical Development") — it exists to demonstrate the feedback-upgrade mechanism (`pipeline/feedback.js`), not to represent a real client conversation.

## What's deterministic vs. LLM-generated

Independent of real-vs-fake data, it's worth knowing what's *computed* vs *written by Claude*:

- **Deterministic (code, `pipeline/scoring.js` + `pipeline/next-step-classifier.js`):** the numeric rubric score per finding, and the recommended next-step category. Stage 3's Claude call receives these as fixed inputs and does not alter them (verified: Stage 3 output scores are byte-identical to Stage 1's computed scores in every run so far).
- **LLM-generated (Claude):** which gap findings exist at all, their evidence tier, their citations and confidence, the prose explanations, and the proposed remedial actions.
