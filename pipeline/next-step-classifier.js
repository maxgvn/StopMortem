import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadThresholds() {
  const filePath = path.join(__dirname, "..", "config", "next-step-thresholds.json");
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

/**
 * Deterministically classifies the recommended next-step category for one gap
 * finding. Thresholds come from config, never inlined here — see
 * config/next-step-thresholds.json.
 */
export function classifyNextStep(finding, deal, thresholds = loadThresholds()) {
  const { thirdPartyReview, clientCallVsInternalFollowup } = thresholds;

  // A finding that is already confirmed and clear never needs escalation —
  // deal size/depth exist to catch genuinely unresolved ambiguity on
  // important deals, not to force a review onto a cause that's already
  // well-substantiated. Check this FIRST, before the size/depth trigger.
  if (finding.evidenceTier === "documented_gap" && finding.confidence > clientCallVsInternalFollowup.ambiguityConfidenceCeiling) {
    return {
      recommendedNextStepCategory: "no_further_investigation_needed",
      nextStepRationale: "Documented gap with high confidence — the evidence speaks for itself, no escalation needed regardless of deal size.",
    };
  }

  const dealIsBigEnough = deal.amount >= thirdPartyReview.minDealAmount;
  const pipelineIsDeepEnough = (deal.pipelineStagesReached || []).some((stage) =>
    thirdPartyReview.minPipelineStagesReached.includes(stage)
  );
  const tripsThirdPartyReview = thirdPartyReview.requireBothConditions
    ? dealIsBigEnough && pipelineIsDeepEnough
    : dealIsBigEnough || pipelineIsDeepEnough;

  if (tripsThirdPartyReview) {
    return {
      recommendedNextStepCategory: "full_third_party_review",
      nextStepRationale: `Deal amount ($${deal.amount}) and pipeline depth (${deal.pipelineStagesReached?.join(", ")}) meet the third-party-review thresholds (min $${thirdPartyReview.minDealAmount}, stages: ${thirdPartyReview.minPipelineStagesReached.join("/")}), and this finding isn't yet confirmed/clear enough to rule out further review.`,
    };
  }

  if (finding.confidence <= clientCallVsInternalFollowup.ambiguityConfidenceCeiling) {
    return {
      recommendedNextStepCategory: "client_call_needed",
      nextStepRationale: `Confidence (${finding.confidence}) is at or below the ambiguity ceiling (${clientCallVsInternalFollowup.ambiguityConfidenceCeiling}) — real ambiguity remains that only the client can resolve.`,
    };
  }

  return {
    recommendedNextStepCategory: "some_internal_followup_needed",
    nextStepRationale: "Evidence tier and confidence don't warrant escalation to the client, but the gap isn't fully resolved internally either.",
  };
}
