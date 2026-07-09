import { getAnthropicClient } from "../lib/anthropic/client.js";
import { STAGE3_MODEL } from "../config/models.js";

const SYSTEM_PROMPT = `You are the root-cause scoring/synthesis agent in StopMortem, a post-mortem system for lost B2B sales deals.

You are given a deal's evidence portrait: gap findings that already have a deterministic evidence tier and a numeric rubric score computed by code. Do NOT recompute, alter, or second-guess these scores — they are ground truth inputs.

Your job:
1. Write a short (2-4 sentence) summary of why this deal was likely lost.
2. For each non-speculative finding provided (already sorted by score, most important first), write a one-paragraph explanation of its role in the loss, citing the specific evidence attached to it. Rank order follows the provided score order.
3. Propose remedial actions grouped by category, sourced only from non-speculative findings (documented_gap / evidence_conflict). Never propose an action sourced only from a speculative (inferred_hypothesis) finding — those are diagnosed only, not actioned.
4. Write department-specific takeaways for exactly these three internal departments: Sales, Pre-Sales, Product. Each is 1-2 sentences, framed for what THAT department specifically should do differently next time — not a repeat of the summary. If a department genuinely has nothing distinct to take from this deal, write "No specific action for this team on this deal" rather than inventing filler.
5. Optionally, ONE sentence noting whether there's any realistic path to re-engage this specific account in the future (e.g. a budget cycle reopening, a stated "revisit next year") — only if the evidence genuinely supports it. This is a minor aside, not a plan — omit it entirely (set to null) if nothing in the evidence supports a recovery angle. Do not speculate beyond what's in the evidence.`;

/** Structured output schema — enforced server-side, so the response can't come back as malformed JSON. */
const POSTMORTEM_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    rankedCauses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          gapFindingId: { type: "string" },
          rank: { type: "integer" },
          score: { type: "number" },
          explanation: { type: "string" },
          evidenceCitations: {
            type: "array",
            items: {
              type: "object",
              properties: { source: { type: "string" }, ref: { type: "string" }, quote: { type: "string" } },
              required: ["source", "ref", "quote"],
              additionalProperties: false,
            },
          },
        },
        required: ["gapFindingId", "rank", "score", "explanation", "evidenceCitations"],
        additionalProperties: false,
      },
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string" },
          description: { type: "string" },
          sourceGapFindingIds: { type: "array", items: { type: "string" } },
        },
        required: ["category", "description", "sourceGapFindingIds"],
        additionalProperties: false,
      },
    },
    departmentInsights: {
      type: "array",
      items: {
        type: "object",
        properties: { department: { type: "string", enum: ["Sales", "Pre-Sales", "Product"] }, insight: { type: "string" } },
        required: ["department", "insight"],
        additionalProperties: false,
      },
    },
    recoveryNote: { type: ["string", "null"] },
  },
  required: ["summary", "rankedCauses", "actions", "departmentInsights", "recoveryNote"],
  additionalProperties: false,
};

const NEXT_STEP_CATEGORIES = ["full_third_party_review", "client_call_needed", "some_internal_followup_needed", "no_further_investigation_needed"];

/** Deterministic rollup of "what actually needs to happen next," across all findings — not left buried as a per-finding badge. */
function buildNextStepsRollup(gapFindings) {
  const rollup = Object.fromEntries(NEXT_STEP_CATEGORIES.map((c) => [c, []]));
  for (const f of gapFindings) {
    const bucket = rollup[f.recommendedNextStepCategory] ?? rollup.some_internal_followup_needed;
    bucket.push({ gapFindingId: f.id, dimension: f.dimension, frameworkId: f.frameworkId ?? null });
  }
  return rollup;
}

export async function runStage3Scoring(portrait) {
  const nonSpeculative = portrait.gapFindings
    .filter((f) => f.evidenceTier !== "inferred_hypothesis")
    .sort((a, b) => b.score - a.score);
  const speculative = portrait.gapFindings.filter((f) => f.evidenceTier === "inferred_hypothesis");

  const client = getAnthropicClient();
  const userMessage = `Deal ID: ${portrait.dealId}

Non-speculative findings (pre-ranked by deterministic score, most important first — do not reorder):
${JSON.stringify(nonSpeculative, null, 2)}

Speculative (inferred_hypothesis) findings — diagnosed only, do NOT create actions for these:
${JSON.stringify(speculative, null, 2)}`;

  const response = await client.messages.create({
    model: STAGE3_MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive", display: "summarized" },
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: POSTMORTEM_OUTPUT_SCHEMA } },
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const parsed = JSON.parse(textBlock.text);

  return {
    dealId: portrait.dealId,
    generatedAt: new Date().toISOString(),
    summary: parsed.summary,
    rankedCauses: parsed.rankedCauses,
    actions: parsed.actions,
    departmentInsights: parsed.departmentInsights ?? [],
    recoveryNote: parsed.recoveryNote ?? null,
    nextStepsRollup: buildNextStepsRollup(portrait.gapFindings),
    speculativeHypotheses: speculative,
  };
}
