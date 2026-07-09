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

Not every dimension needs a finding — only create a gapFindings entry for a dimension when there is a genuine gap, conflict, or a hypothesis worth flagging. A dimension with clean, well-corroborated evidence and no ambiguity does not need an entry.

Every finding must cite the specific evidence it's based on (note field, email, activity entry, proposal, or a tool result) — never assert a conclusion without a citation. Assign a confidence score (0-1) reflecting how certain you are, independent of evidence tier.`;
}

export function validateGapFindings(findings, framework) {
  const validKeys = new Set(framework.dimensions.map((d) => d.key));
  const invalid = findings.filter((f) => !validKeys.has(f.dimension));
  if (invalid.length > 0) {
    throw new Error(
      `Gap findings reference unknown dimensions for framework "${framework.id}": ${invalid.map((f) => f.dimension).join(", ")}`
    );
  }
}
