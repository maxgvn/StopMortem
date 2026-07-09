/**
 * Framework-agnostic helpers for Stage 1's gap scan. This module never imports a
 * specific framework (e.g. meddpicc.json) — it only ever operates on a framework
 * object passed in by the caller, so swapping frameworks is a config change.
 */

export function buildGapScanInstructions(framework) {
  const dimensionLines = framework.dimensions
    .map((d) => `- **${d.key}** (${d.label}): ${d.description}`)
    .join("\n");

  return `Evaluate the deal's evidence against every dimension of the "${framework.label}" framework:

${dimensionLines}

For each dimension, decide one evidence tier:
- "documented_gap" — required evidence for this dimension is simply absent from the CRM notes/activity/emails/proposal.
- "evidence_conflict" — the dimension was captured, but other evidence (activity, proposal, enrichment) contradicts it.
- "inferred_hypothesis" — no evidence directly speaks to it; you are inferring it. Never present this as a fact.

Not every dimension needs a finding — only create a gapFindings entry for a dimension when there is a genuine gap, conflict, or a hypothesis worth flagging. A dimension with clean, well-corroborated evidence and no ambiguity does not need an entry. If, after reviewing every dimension, the evidence points to one clear, well-substantiated cause and nothing else is genuinely in question, it is correct and expected to produce zero "inferred_hypothesis" findings — do not manufacture a speculative finding on an unrelated dimension just to appear thorough. A short list of confirmed findings and no loose hypotheses is a better outcome than padding.

Every finding must cite the specific evidence it's based on (note field, email, activity entry, proposal, or a tool result) — never assert a conclusion without a citation. Assign a confidence score (0-1) reflecting how certain you are, independent of evidence tier.`;
}

/**
 * A second, independent gap scan layered on top of the primary framework —
 * only run when the deal's industry warrants it (see `appliesToIndustry`
 * below). Produces findings using the exact same evidence-tier rules and
 * finding-id convention as the primary scan, just against a different
 * dimension list — this is what makes "framework is swappable/composable,
 * not hardcoded" a demonstrated fact rather than just an architecture claim.
 */
export function buildAddOnInstructions(addOnFramework) {
  const dimensionLines = addOnFramework.dimensions
    .map((d) => `- **${d.key}** (${d.label}): ${d.description}`)
    .join("\n");

  return `This deal is also in scope for a SEPARATE, complementary compliance add-on scan — "${addOnFramework.label}". This is not part of the qualification framework above; run it as an additional, independent pass:

${dimensionLines}

Use the exact same evidence-tier rules (documented_gap / evidence_conflict / inferred_hypothesis), the same finding-id convention ("<dealId>-<dimension>"), and the same citation requirement as the qualification scan above. These add-on findings will be visually separated from the qualification findings downstream — you don't need to do anything special to mark them, just use the dimension keys listed here (they don't overlap with the qualification framework's keys).`;
}

export function appliesToIndustry(addOnFramework, dealIndustry) {
  if (!dealIndustry) return false;
  return (addOnFramework.appliesWhenDealIndustryIn ?? []).includes(dealIndustry);
}

export function validateGapFindings(findings, frameworks) {
  const frameworkList = Array.isArray(frameworks) ? frameworks : [frameworks];
  const validKeys = new Set(frameworkList.flatMap((fw) => fw.dimensions.map((d) => d.key)));
  const invalid = findings.filter((f) => !validKeys.has(f.dimension));
  if (invalid.length > 0) {
    throw new Error(
      `Gap findings reference dimensions not in any active framework (${frameworkList.map((f) => f.id).join(", ")}): ${invalid.map((f) => f.dimension).join(", ")}`
    );
  }
}

/** Tags each finding with the id of whichever active framework actually owns its dimension. */
export function tagFindingsWithFramework(findings, frameworks) {
  const frameworkList = Array.isArray(frameworks) ? frameworks : [frameworks];
  return findings.map((f) => {
    const owner = frameworkList.find((fw) => fw.dimensions.some((d) => d.key === f.dimension));
    return { ...f, frameworkId: owner?.id ?? frameworkList[0].id };
  });
}
