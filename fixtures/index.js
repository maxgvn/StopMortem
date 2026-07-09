import { readFileSync, readdirSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dealsDir = path.join(__dirname, "deals");
const feedbackDir = path.join(__dirname, "feedback");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

export function listDeals() {
  return readdirSync(dealsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(dealsDir, f)))
    .sort((a, b) => a.dealId.localeCompare(b.dealId));
}

export function getDeal(dealId) {
  const match = readdirSync(dealsDir).find((f) => f.startsWith(`${dealId}-`) || f === `${dealId}.json`);
  if (!match) {
    throw new Error(`No fixture deal found for dealId "${dealId}"`);
  }
  return readJson(path.join(dealsDir, match));
}

export function getFeedback(dealId) {
  const filePath = path.join(feedbackDir, `${dealId}-feedback.json`);
  if (!existsSync(filePath)) return null;
  return readJson(filePath);
}
