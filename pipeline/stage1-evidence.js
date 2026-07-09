import { getAnthropicClient } from "../lib/anthropic/client.js";
import { STAGE1_MODEL } from "../config/models.js";
import { sillageToolDefinitions, sillageToolDispatch } from "../lib/sillage/tools.js";
import { fullEnrichToolDefinitions, fullEnrichToolDispatch } from "../lib/fullenrich/tools.js";
import { buildGapScanInstructions, validateGapFindings } from "./gap-scan.js";
import { classifyNextStep } from "./next-step-classifier.js";
import { scoreAllFindings } from "./scoring.js";
import { extractJson } from "./util.js";

const toolDispatch = { ...sillageToolDispatch, ...fullEnrichToolDispatch };
const toolDefinitions = [...sillageToolDefinitions, ...fullEnrichToolDefinitions];

const MAX_ITERATIONS = 12;

function buildSystemPrompt(framework) {
  return `You are the evidence-gathering agent in StopMortem, a post-mortem system for lost B2B sales deals.

Your job in this session is ONLY to build a complete, evidence-backed portrait of one lost deal. You do NOT rank root causes, propose remedial actions, or decide what caused the loss — that happens in a separate later stage. Your output is diagnostic evidence, not a conclusion.

Treat the deal's recorded "closed lost reason" as a claim to verify against the evidence, not as ground truth.

You have tools to enrich companies and people via Sillage and FullEnrich — use them. Specifically:
- Enrich the deal's own company and any named competitors.
- For every stakeholder known only by title (no name recorded), try to resolve who they actually are — use fullenrich_reverse_email if an email address for them appears in the evidence, or fullenrich_lookup_person if a name is mentioned elsewhere.
- Use fullenrich_search_companies for competitive/market-landscape context on named competitors.
- sillage_workspace_signals and sillage_persona_context are available but this workspace's signals may be tuned for a different persona than this deal — judge relevance yourself; don't assume they're useful.
Call tools as many times as genuinely useful. Don't call a tool just to call it.

${buildGapScanInstructions(framework)}

When you are done gathering evidence and running the gap scan, respond with ONLY a single JSON object (no markdown fences, no commentary) matching this shape:
{
  "claimUnderReview": {"field": "closedLostReason", "value": "<the stated reason>", "note": "treated as a claim to verify, not ground truth"},
  "stakeholderMap": [{"name": string|null, "title": string, "seniorityLevel": string|null, "company": string, "roleHint": string, "engagementEvidence": [string], "lastTouchDate": string|null, "enrichment": {"sillage": <concise 1-3 field summary or null, NOT the raw tool result>, "fullenrich": <concise 1-3 field summary or null, NOT the raw tool result>}}],
  "competitiveContext": {"competitorsNamed": [...], "marketSignals": [...]},
  "gapFindings": [{"id": "<dealId>-<dimension>", "dimension": string, "evidenceTier": "documented_gap"|"evidence_conflict"|"inferred_hypothesis", "statement": string, "evidenceCitations": [{"source": string, "ref": string, "quote": string}], "confidence": number}],
  "openQuestionsForFeedback": [{"gapFindingId": string, "question": string}]
}

Use "<dealId>-<dimension>" as the finding id (e.g. "deal-003-competition") so downstream feedback fixtures can reference it deterministically.

Keep the final JSON compact: summarize tool results into a few key facts rather than embedding raw tool output, and keep evidenceCitations quotes short. The output must fit well within your token budget.`;
}

export async function runStage1Evidence(deal, framework) {
  const client = getAnthropicClient();
  const system = buildSystemPrompt(framework);
  const toolCallLog = [];

  let messages = [
    {
      role: "user",
      content: `Here is the full CRM export for this lost deal. Build the evidence portrait.\n\n${JSON.stringify(deal, null, 2)}`,
    },
  ];

  let finalText = null;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: STAGE1_MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system,
      tools: toolDefinitions,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

    if (response.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
      if (response.stop_reason === "max_tokens") {
        throw new Error(`Stage 1 hit max_tokens before finishing its final answer for deal ${deal.dealId} — increase max_tokens or shorten the required output.`);
      }
      const textBlock = response.content.find((b) => b.type === "text");
      finalText = textBlock?.text ?? "";
      break;
    }

    const toolResults = [];
    for (const block of toolUseBlocks) {
      const dispatch = toolDispatch[block.name];
      const timestampIso = new Date().toISOString();
      try {
        const result = dispatch ? await dispatch(block.input) : { error: `Unknown tool "${block.name}"` };
        toolCallLog.push({
          tool: block.name,
          argsSummary: JSON.stringify(block.input),
          resultSummary: JSON.stringify(result).slice(0, 500),
          timestampIso,
        });
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
      } catch (err) {
        toolCallLog.push({ tool: block.name, argsSummary: JSON.stringify(block.input), resultSummary: `ERROR: ${err.message}`, timestampIso });
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  if (finalText === null) {
    throw new Error(`Stage 1 exceeded ${MAX_ITERATIONS} tool-calling iterations without a final answer for deal ${deal.dealId}`);
  }

  const parsed = extractJson(finalText);
  validateGapFindings(parsed.gapFindings, framework);

  const findingsWithNextStep = parsed.gapFindings.map((f) => ({
    ...f,
    ...classifyNextStep(f, deal.deal),
  }));
  const findingsWithScore = scoreAllFindings(findingsWithNextStep, framework);

  return {
    dealId: deal.dealId,
    framework: { id: framework.id, version: "1.0" },
    generatedAt: new Date().toISOString(),
    claimUnderReview: parsed.claimUnderReview,
    stakeholderMap: parsed.stakeholderMap,
    competitiveContext: parsed.competitiveContext,
    gapFindings: findingsWithScore,
    openQuestionsForFeedback: parsed.openQuestionsForFeedback ?? [],
    toolCallLog,
  };
}
