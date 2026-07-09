import { getDeal } from "../fixtures/index.js";
import { loadFramework } from "../config/frameworks/index.js";
import { appliesToIndustry } from "./gap-scan.js";
import { runStage1Evidence } from "./stage1-evidence.js";
import { reconcileFeedback } from "./feedback.js";
import { runStage3Scoring } from "./stage3-scoring.js";
import { publish as publishLocalFile } from "../output/writeback/local-file-adapter.js";
import { buildPublishTargets } from "../output/publish-targets.js";

const ADDON_FRAMEWORK_ID = "pharma-compliance-addon";

function resolveActiveFrameworks(deal, frameworkId) {
  const framework = loadFramework(frameworkId);
  const addOnCandidate = loadFramework(ADDON_FRAMEWORK_ID);
  const addOnFramework = appliesToIndustry(addOnCandidate, deal.meta.industry) ? addOnCandidate : null;
  return { framework, addOnFramework, activeFrameworks: addOnFramework ? [framework, addOnFramework] : [framework] };
}

async function finishAndPublish(dealId, postmortemDraft, finalPortrait) {
  const { location } = await publishLocalFile(postmortemDraft, finalPortrait);
  const postmortem = { ...postmortemDraft, publishTargets: buildPublishTargets({ location, dealId }) };
  return { postmortem, location };
}

/**
 * Runs just Stage 1 (the slow, tool-heavy part) and returns everything Stage 3 needs to
 * finish the job. Split out from runPostMortem so the run registry can surface the
 * evidence portrait to the UI the moment it's ready, instead of only once the entire
 * (Stage 1 + Stage 3) promise resolves.
 */
export async function runStage1Only({ dealId, frameworkId = "meddpicc" }) {
  const deal = getDeal(dealId);
  const { framework, addOnFramework, activeFrameworks } = resolveActiveFrameworks(deal, frameworkId);
  const portrait = await runStage1Evidence(deal, framework, addOnFramework);
  return { deal, activeFrameworks, portrait };
}

/** Stage 2 (optional feedback reconciliation) + Stage 3 + publish, given an already-computed Stage 1 portrait. */
export async function finishPostMortem({ deal, activeFrameworks, portrait, feedbackInput = null }) {
  const finalPortrait = feedbackInput ? reconcileFeedback(portrait, feedbackInput, activeFrameworks, deal) : portrait;

  const postmortemDraft = await runStage3Scoring(finalPortrait, deal);
  const { postmortem, location } = await finishAndPublish(deal.dealId, postmortemDraft, finalPortrait);

  return { portrait, finalPortrait, postmortem, location };
}

/**
 * @param {object} opts
 * @param {string} opts.dealId
 * @param {object|null} [opts.feedbackInput] - pass a feedback object to apply it, or omit/null to waive the feedback stage entirely
 * @param {string} [opts.frameworkId]
 */
export async function runPostMortem({ dealId, feedbackInput = null, frameworkId = "meddpicc" }) {
  const { deal, activeFrameworks, portrait } = await runStage1Only({ dealId, frameworkId });
  return finishPostMortem({ deal, activeFrameworks, portrait, feedbackInput });
}

/**
 * Re-runs Stage 2 (feedback reconciliation) + Stage 3 against an ALREADY-computed
 * Stage 1 portrait — for manually entered feedback via the UI. Never re-runs
 * Stage 1's tool-calling loop, so this is fast (one Claude call, no Sillage/
 * FullEnrich traffic) and doesn't re-spend that cost just to attach feedback.
 */
export async function rerunWithFeedback({ portrait, feedbackInput }) {
  const deal = getDeal(portrait.dealId);
  const { activeFrameworks } = resolveActiveFrameworks(deal, portrait.framework.id);
  return finishPostMortem({ deal, activeFrameworks, portrait, feedbackInput });
}
