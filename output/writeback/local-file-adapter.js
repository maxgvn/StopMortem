import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { renderMarkdown } from "../render-markdown.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runsDir = path.join(__dirname, "..", "..", "runs");

export async function publish(postmortem, portrait) {
  const runId = `${portrait.dealId}-${Date.now()}`;
  const dir = path.join(runsDir, runId);
  mkdirSync(dir, { recursive: true });

  writeFileSync(path.join(dir, "portrait.json"), JSON.stringify(portrait, null, 2));
  writeFileSync(path.join(dir, "postmortem.json"), JSON.stringify(postmortem, null, 2));
  writeFileSync(path.join(dir, "report.md"), renderMarkdown(postmortem, portrait));

  return { location: dir };
}
