import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadRubric() {
  const filePath = path.join(__dirname, "..", "config", "scoring-rubric.json");
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

/**
 * Deterministic rubric score for one gap finding — computed in code, never by
 * the LLM. Stage 3 receives these precomputed scores and narrates/ranks against
 * them; it does not invent the arithmetic.
 */
export function scoreFinding(finding, framework, rubric = loadRubric()) {
  const tierWeight = rubric.tierWeights[finding.evidenceTier] ?? 0;
  const dimension = framework.dimensions.find((d) => d.key === finding.dimension);
  const causalWeight = dimension?.causalWeightHint ?? rubric.defaultCausalWeight;

  const citationCount = finding.evidenceCitations?.length ?? 0;
  const corroborationBonus = Math.min(
    Math.max(citationCount - 1, 0) * rubric.corroborationBonus.perAdditionalCitation,
    rubric.corroborationBonus.max
  );

  const score = tierWeight * causalWeight + corroborationBonus;
  return Math.round(score * 1000) / 1000;
}

export function scoreAllFindings(findings, framework, rubric = loadRubric()) {
  return findings.map((f) => ({ ...f, score: scoreFinding(f, framework, rubric) }));
}
