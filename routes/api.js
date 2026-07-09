import express from "express";
import { listDeals, getDeal, getFeedback } from "../fixtures/index.js";
import { startRun, startFeedbackRerun, getRun, getLatestRunForDeal } from "../pipeline/run-registry.js";
import { verifyKey as verifyFullEnrichKey } from "../lib/fullenrich/client.js";
import { getTargetListStatus as verifySillageConnection } from "../lib/sillage/client.js";

export const router = express.Router();

router.get("/deals", (req, res) => {
  const deals = listDeals().map((d) => {
    const latestRun = getLatestRunForDeal(d.dealId);
    return {
      dealId: d.dealId,
      dealName: d.meta.dealName,
      tier: d.meta.tier,
      industry: d.meta.industry ?? null,
      company: d.company.name,
      amount: d.deal.amount,
      stage: d.deal.stage,
      closedLostReason: d.deal.closedLostReason ?? null,
      closedWonReason: d.deal.closedWonReason ?? null,
      accountTier: d.company.hubspot?.accountTier ?? null,
      hasFeedback: Boolean(getFeedback(d.dealId)),
      activeRun: latestRun ? { runId: latestRun.runId, status: latestRun.status, triggeredBy: latestRun.triggeredBy } : null,
    };
  });
  res.json(deals);
});

router.get("/deals/:id", (req, res) => {
  try {
    res.json(getDeal(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/** Starts a run and returns immediately — the run keeps executing server-side regardless of the client. */
router.post("/deals/:id/run", (req, res) => {
  const { id } = req.params;
  const waiveFeedback = req.body?.waiveFeedback === true;
  try {
    const deal = getDeal(id); // 404 early if the deal doesn't exist, before starting anything
    if (deal.deal.stage === "closed_won") {
      return res.status(400).json({ error: "This deal was won — there's no loss to analyze, so a post-mortem isn't applicable." });
    }
    const feedbackInput = waiveFeedback ? null : getFeedback(id);
    const runId = startRun({ dealId: id, feedbackInput, triggeredBy: "manual" });
    res.status(202).json({ runId, status: "running" });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/** Simulates a CRM ("deal marked Closed Lost") webhook auto-triggering a run — no manual click needed. */
router.post("/webhooks/deal-closed", (req, res) => {
  const { dealId } = req.body ?? {};
  if (!dealId) return res.status(400).json({ error: "dealId is required" });
  try {
    const deal = getDeal(dealId);
    if (deal.deal.stage === "closed_won") {
      return res.status(400).json({ error: "This deal was won — there's no loss to analyze, so a post-mortem isn't applicable." });
    }
    const feedbackInput = getFeedback(dealId);
    const runId = startRun({ dealId, feedbackInput, triggeredBy: "crm_webhook" });
    res.status(202).json({ runId, status: "running", triggeredBy: "crm_webhook" });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * Manually-entered feedback (e.g. a rep typing in what a client said on a call),
 * as an alternative to the fixture-file feedback path. Re-runs only Stage 2 +
 * Stage 3 against the deal's most recent completed Stage 1 portrait — does not
 * repeat Stage 1's tool-calling loop or its Sillage/FullEnrich calls.
 */
router.post("/deals/:id/feedback", (req, res) => {
  const { id } = req.params;
  const latest = getLatestRunForDeal(id);
  if (!latest || latest.status !== "completed") {
    return res.status(400).json({ error: "No completed run for this deal yet — run the post-mortem first." });
  }
  const { findings, collectedVia } = req.body ?? {};
  if (!findings || Object.keys(findings).length === 0) {
    return res.status(400).json({ error: "findings is required (a map of gapFindingId -> {clientConfirms, clientDisputes, note})" });
  }
  const feedbackInput = {
    dealId: id,
    collectedVia: collectedVia || "manual entry (UI)",
    collectedDate: new Date().toISOString(),
    findings,
  };
  const runId = startFeedbackRerun({ portrait: latest.result.portrait, feedbackInput });
  res.status(202).json({ runId, status: "running" });
});

router.get("/runs/:runId", (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: "Unknown runId" });
  res.json(run);
});

/** Lets the frontend resume showing an in-progress or just-finished run after navigating away and back. */
router.get("/deals/:id/latest-run", (req, res) => {
  const run = getLatestRunForDeal(req.params.id);
  res.json(run);
});

/** Live connection status for each integration — for the always-visible status strip, not an admin panel. */
router.get("/status", async (req, res) => {
  const status = { sillage: "unknown", fullenrich: "unknown", hubspot: "not_integrated" };

  try {
    await verifySillageConnection();
    status.sillage = "connected";
  } catch {
    status.sillage = "error";
  }

  try {
    await verifyFullEnrichKey();
    status.fullenrich = "connected";
  } catch {
    status.fullenrich = "error";
  }

  res.json(status);
});
