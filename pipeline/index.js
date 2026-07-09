import { getDeal } from "../fixtures/index.js";
import { loadFramework } from "../config/frameworks/index.js";
import { runStage1Evidence } from "./stage1-evidence.js";
import { reconcileFeedback } from "./feedback.js";
import { runStage3Scoring } from "./stage3-scoring.js";
import { publish as publishLocalFile } from "../output/writeback/local-file-adapter.js";

/**
 * @param {object} opts
 * @param {string} opts.dealId
 * @param {object|null} [opts.feedbackInput] - pass a feedback object to apply it, or omit/null to waive the feedback stage entirely
 * @param {string} [opts.frameworkId]
 */
export async function runPostMortem({ dealId, feedbackInput = null, frameworkId = "meddpicc" }) {
  const deal = getDeal(dealId);
  const framework = loadFramework(frameworkId);

  const portrait = await runStage1Evidence(deal, framework);

  const finalPortrait = feedbackInput ? reconcileFeedback(portrait, feedbackInput, framework, deal) : portrait;

  const postmortem = await runStage3Scoring(finalPortrait);
  const { location } = await publishLocalFile(postmortem, finalPortrait);

  return { portrait, finalPortrait, postmortem, location };
}
