import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { router as apiRouter } from "./routes/api.js";
import { listDeals, getFeedback } from "./fixtures/index.js";
import { startRun } from "./pipeline/run-registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = 3000;

app.use(express.json());
app.use("/api", apiRouter);
app.use(express.static(path.join(__dirname, "public")));

/**
 * Simulates a couple of CRM "deal closed" webhooks firing on their own at
 * startup — the first lost deal (so the app never lands on an empty state)
 * plus one other random lost deal, exactly like a real HubSpot workflow
 * auto-triggering StopMortem the moment a rep marks a deal Closed Lost.
 */
function seedAutoTriggeredRuns() {
  const lostDeals = listDeals().filter((d) => d.deal.stage === "closed_lost");
  if (lostDeals.length === 0) return;
  const [first, ...rest] = lostDeals;
  const randomOther = rest[Math.floor(Math.random() * rest.length)];
  const toTrigger = randomOther ? [first, randomOther] : [first];
  for (const deal of toTrigger) {
    startRun({ dealId: deal.dealId, feedbackInput: getFeedback(deal.dealId), triggeredBy: "crm_webhook" });
    console.log(`Auto-triggered post-mortem for ${deal.dealId} (simulated CRM webhook)`);
  }
}

app.listen(PORT, () => {
  console.log(`StopMortem listening on http://localhost:${PORT}`);
  seedAutoTriggeredRuns();
});
