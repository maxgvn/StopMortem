import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadRubric() {
  const filePath = path.join(__dirname, "..", "config", "scoring-rubric.json");
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function findDimension(dimensionKey, frameworks) {
  for (const fw of frameworks) {
    const match = fw.dimensions.find((d) => d.key === dimensionKey);
    if (match) return match;
  }
  return undefined;
}

/**
 * Deterministic rubric score for one gap finding — computed in code, never by
 * the LLM. Stage 3 receives these precomputed scores and narrates/ranks against
 * them; it does not invent the arithmetic.
 *
 * `frameworks` may be a single framework object or an array (primary framework
 * + any active add-on frameworks) — dimension keys are looked up across all of
 * them, since add-on frameworks use distinct, non-colliding dimension keys.
 */
export function scoreFinding(finding, frameworks, rubric = loadRubric()) {
  const frameworkList = Array.isArray(frameworks) ? frameworks : [frameworks];
  const tierWeight = rubric.tierWeights[finding.evidenceTier] ?? 0;
  const dimension = findDimension(finding.dimension, frameworkList);
  const causalWeight = dimension?.causalWeightHint ?? rubric.defaultCausalWeight;

  const citationCount = finding.evidenceCitations?.length ?? 0;
  const corroborationBonus = Math.min(
    Math.max(citationCount - 1, 0) * rubric.corroborationBonus.perAdditionalCitation,
    rubric.corroborationBonus.max
  );

  const score = tierWeight * causalWeight + corroborationBonus;
  return Math.round(score * 1000) / 1000;
}

export function scoreAllFindings(findings, frameworks, rubric = loadRubric()) {
  return findings.map((f) => ({ ...f, score: scoreFinding(f, frameworks, rubric) }));
}
