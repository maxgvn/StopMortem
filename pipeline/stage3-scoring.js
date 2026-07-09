import { getAnthropicClient } from "../lib/anthropic/client.js";
import { STAGE3_MODEL } from "../config/models.js";
import { extractJson } from "./util.js";

const SYSTEM_PROMPT = `You are the root-cause scoring/synthesis agent in StopMortem, a post-mortem system for lost B2B sales deals.

You are given a deal's evidence portrait: gap findings that already have a deterministic evidence tier and a numeric rubric score computed by code. Do NOT recompute, alter, or second-guess these scores — they are ground truth inputs.

Your job:
1. Write a short (2-4 sentence) summary of why this deal was likely lost.
2. For each non-speculative finding provided (already sorted by score, most important first), write a one-paragraph explanation of its role in the loss, citing the specific evidence attached to it. Rank order follows the provided score order.
3. Propose remedial actions grouped by category, sourced only from non-speculative findings (documented_gap / evidence_conflict). Never propose an action sourced only from a speculative (inferred_hypothesis) finding — those are diagnosed only, not actioned.

Respond with ONLY a single JSON object (no markdown fences, no commentary):
{
  "summary": string,
  "rankedCauses": [{"gapFindingId": string, "rank": integer, "score": number, "explanation": string, "evidenceCitations": [...]}],
  "actions": [{"category": string, "description": string, "sourceGapFindingIds": [string]}]
}`;

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
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const parsed = extractJson(textBlock.text);

  return {
    dealId: portrait.dealId,
    generatedAt: new Date().toISOString(),
    summary: parsed.summary,
    rankedCauses: parsed.rankedCauses,
    actions: parsed.actions,
    speculativeHypotheses: speculative,
  };
}
