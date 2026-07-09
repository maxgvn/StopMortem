import express from "express";
import { listDeals, getDeal, getFeedback } from "../fixtures/index.js";
import { runPostMortem } from "../pipeline/index.js";

export const router = express.Router();

router.get("/deals", (req, res) => {
  const deals = listDeals().map((d) => ({
    dealId: d.dealId,
    dealName: d.meta.dealName,
    tier: d.meta.tier,
    company: d.company.name,
    amount: d.deal.amount,
    closedLostReason: d.deal.closedLostReason,
    hasFeedback: Boolean(getFeedback(d.dealId)),
  }));
  res.json(deals);
});

router.get("/deals/:id", (req, res) => {
  try {
    res.json(getDeal(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post("/deals/:id/run", async (req, res) => {
  const { id } = req.params;
  const waiveFeedback = req.body?.waiveFeedback === true;
  try {
    const feedbackInput = waiveFeedback ? null : getFeedback(id);
    const { portrait, postmortem, finalPortrait, location } = await runPostMortem({ dealId: id, feedbackInput });
    res.json({
      postmortem,
      portrait,
      finalPortrait,
      feedbackApplied: Boolean(feedbackInput),
      feedbackInput,
      location,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
