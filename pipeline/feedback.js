import { classifyNextStep } from "./next-step-classifier.js";
import { scoreAllFindings } from "./scoring.js";

/**
 * Pure, schema-preserving transform. Never changes the shape Stage 3 consumes —
 * only mutates gapFindings[] entries in place. Findings not referenced in
 * feedbackInput are left untouched: "never actioned until confirmed" stays
 * enforced structurally, not just by convention.
 */
export function reconcileFeedback(portrait, feedbackInput, framework, deal) {
  if (!feedbackInput) return portrait;

  const updatedFindings = portrait.gapFindings.map((finding) => {
    const fb = feedbackInput.findings[finding.id];
    if (!fb) return finding;

    const upgradedTier = fb.clientConfirms ? (fb.clientDisputes ? "evidence_conflict" : "documented_gap") : finding.evidenceTier;

    return {
      ...finding,
      evidenceTier: upgradedTier,
      confidence: fb.clientConfirms ? 0.95 : finding.confidence,
      evidenceCitations: [
        ...finding.evidenceCitations,
        { source: "client_feedback", ref: feedbackInput.collectedVia ?? "client_feedback", quote: fb.note },
      ],
    };
  });

  const withNextStep = updatedFindings.map((f) => ({ ...f, ...classifyNextStep(f, deal.deal) }));
  const withScore = scoreAllFindings(withNextStep, framework);

  return { ...portrait, gapFindings: withScore };
}
