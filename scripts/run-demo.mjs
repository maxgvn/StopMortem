import "dotenv/config";
import { readFileSync } from "fs";
import { runPostMortem } from "../pipeline/index.js";
import { getFeedback } from "../fixtures/index.js";

function parseArgs(argv) {
  const args = { deal: null, feedback: null, waiveFeedback: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--deal") args.deal = argv[++i];
    else if (argv[i] === "--feedback") args.feedback = argv[++i];
    else if (argv[i] === "--waive-feedback") args.waiveFeedback = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.deal) {
    console.error("Usage: node scripts/run-demo.mjs --deal <dealId> [--feedback <path> | --waive-feedback]");
    process.exit(1);
  }

  let feedbackInput = null;
  if (args.feedback) {
    feedbackInput = JSON.parse(readFileSync(args.feedback, "utf-8"));
  } else if (!args.waiveFeedback) {
    feedbackInput = getFeedback(args.deal);
    if (feedbackInput) {
      console.log(`(auto-loaded fixtures/feedback/${args.deal}-feedback.json — pass --waive-feedback to skip)`);
    }
  }

  console.log(`Running post-mortem for ${args.deal}${feedbackInput ? " with feedback" : " (no feedback)"}...`);
  const { postmortem, finalPortrait, location } = await runPostMortem({ dealId: args.deal, feedbackInput });

  console.log(`\nDone. Output written to: ${location}`);
  console.log(`Tool calls made: ${finalPortrait.toolCallLog.length}`);
  console.log(`Gap findings: ${finalPortrait.gapFindings.length}`);
  console.log(`\nSummary: ${postmortem.summary}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
