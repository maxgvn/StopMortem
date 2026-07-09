import { runStage1Only, finishPostMortem, rerunWithFeedback } from "./index.js";

/**
 * In-memory registry so a pipeline run is decoupled from any single HTTP
 * request or browser tab. A run keeps executing on the server regardless of
 * whether the client that started it is still connected — the client (or a
 * webhook, or a totally different client) polls `getRun(runId)` for status.
 * Resets on server restart; each run's final output still lands on disk via
 * the writeback adapter, same as before.
 *
 * `entry.portrait` is populated as soon as Stage 1 finishes — before `status`
 * flips to "completed" — so the UI can show the Evidence Portrait tab while
 * Stage 2/3 are still running, instead of one opaque wait for the whole thing.
 * `entry.stage` tracks which phase is currently running ("evidence_gathering"
 * or "synthesizing") for the same reason.
 */
const runs = new Map();

function makeRunId(dealId) {
  return `${dealId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function registerEntry(dealId, triggeredBy) {
  const runId = makeRunId(dealId);
  const entry = {
    runId,
    dealId,
    triggeredBy,
    status: "running",
    stage: "evidence_gathering",
    startedAt: new Date().toISOString(),
    portrait: null,
    result: null,
    error: null,
  };
  runs.set(runId, entry);
  return entry;
}

export function startRun({ dealId, feedbackInput = null, triggeredBy = "manual" }) {
  const entry = registerEntry(dealId, triggeredBy);

  (async () => {
    try {
      const { deal, activeFrameworks, portrait } = await runStage1Only({ dealId });
      entry.portrait = portrait; // visible to pollers immediately, well before Stage 3 finishes
      entry.stage = "synthesizing";
      const result = await finishPostMortem({ deal, activeFrameworks, portrait, feedbackInput });
      entry.status = "completed";
      entry.completedAt = new Date().toISOString();
      entry.result = result;
    } catch (err) {
      console.error(`Run ${entry.runId} failed:`, err);
      entry.status = "error";
      entry.completedAt = new Date().toISOString();
      entry.error = err.message;
    }
  })();

  return entry.runId;
}

/** For manually-entered feedback via the UI — re-runs only Stage 2 + Stage 3 against an already-computed portrait. */
export function startFeedbackRerun({ portrait, feedbackInput }) {
  const entry = registerEntry(portrait.dealId, "manual_feedback");
  entry.portrait = portrait; // already known upfront — no Stage 1 wait for this path
  entry.stage = "synthesizing";

  rerunWithFeedback({ portrait, feedbackInput })
    .then((result) => {
      entry.status = "completed";
      entry.completedAt = new Date().toISOString();
      entry.result = result;
    })
    .catch((err) => {
      console.error(`Run ${entry.runId} failed:`, err);
      entry.status = "error";
      entry.completedAt = new Date().toISOString();
      entry.error = err.message;
    });

  return entry.runId;
}

export function getRun(runId) {
  return runs.get(runId) ?? null;
}

/** Most recent run (of any status) for a given deal — lets the UI resume showing progress/results after a navigation. */
export function getLatestRunForDeal(dealId) {
  let latest = null;
  for (const run of runs.values()) {
    if (run.dealId === dealId && (!latest || run.startedAt > latest.startedAt)) latest = run;
  }
  return latest;
}
