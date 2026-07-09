import { runPostMortem, rerunWithFeedback } from "./index.js";

/**
 * In-memory registry so a pipeline run is decoupled from any single HTTP
 * request or browser tab. A run keeps executing on the server regardless of
 * whether the client that started it is still connected — the client (or a
 * webhook, or a totally different client) polls `getRun(runId)` for status.
 * Resets on server restart; each run's final output still lands on disk via
 * the writeback adapter, same as before.
 */
const runs = new Map();

function makeRunId(dealId) {
  return `${dealId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function register(dealId, triggeredBy, task) {
  const runId = makeRunId(dealId);
  const entry = { runId, dealId, triggeredBy, status: "running", startedAt: new Date().toISOString(), result: null, error: null };
  runs.set(runId, entry);

  task
    .then((result) => {
      entry.status = "completed";
      entry.completedAt = new Date().toISOString();
      entry.result = result;
    })
    .catch((err) => {
      console.error(`Run ${runId} failed:`, err);
      entry.status = "error";
      entry.completedAt = new Date().toISOString();
      entry.error = err.message;
    });

  return runId;
}

export function startRun({ dealId, feedbackInput = null, triggeredBy = "manual" }) {
  return register(dealId, triggeredBy, runPostMortem({ dealId, feedbackInput }));
}

/** For manually-entered feedback via the UI — re-runs only Stage 2 + Stage 3 against an already-computed portrait. */
export function startFeedbackRerun({ portrait, feedbackInput }) {
  return register(portrait.dealId, "manual_feedback", rerunWithFeedback({ portrait, feedbackInput }));
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
