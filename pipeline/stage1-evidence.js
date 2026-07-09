import { getAnthropicClient } from "../lib/anthropic/client.js";
import { STAGE1_MODEL } from "../config/models.js";
import { sillageToolDefinitions, sillageToolDispatch } from "../lib/sillage/tools.js";
import { fullEnrichToolDefinitions, fullEnrichToolDispatch } from "../lib/fullenrich/tools.js";
import { buildGapScanInstructions, buildAddOnInstructions, validateGapFindings, tagFindingsWithFramework } from "./gap-scan.js";
import { classifyNextStep } from "./next-step-classifier.js";
import { scoreAllFindings } from "./rubric-scoring.js";

const toolDispatch = { ...sillageToolDispatch, ...fullEnrichToolDispatch };
const toolDefinitions = [...sillageToolDefinitions, ...fullEnrichToolDefinitions];

const MAX_ITERATIONS = 12;

/**
 * Structured output schema for Stage 1's final answer. Using `output_config.format`
 * instead of a "respond with ONLY JSON" text instruction — this is enforced
 * server-side, so it can't come back malformed (an earlier version parsed raw
 * text with a hand-rolled markdown-fence stripper + JSON.parse, which broke
 * whenever the model wrote an internal quote character without escaping it).
 */
const DEAL_PORTRAIT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    claimUnderReview: {
      type: "object",
      properties: {
        field: { type: "string" },
        value: { type: ["string", "null"] },
        note: { type: "string" },
      },
      required: ["field", "value", "note"],
      additionalProperties: false,
    },
    stakeholderMap: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: ["string", "null"] },
          title: { type: "string" },
          seniorityLevel: { type: ["string", "null"] },
          company: { type: "string" },
          roleHint: { type: "string" },
          engagementEvidence: { type: "array", items: { type: "string" } },
          lastTouchDate: { type: ["string", "null"] },
          sillageEnrichmentSummary: { type: ["string", "null"], description: "1-3 concise facts, or null — never the raw tool result" },
          fullenrichEnrichmentSummary: { type: ["string", "null"], description: "1-3 concise facts, or null — never the raw tool result" },
        },
        required: ["name", "title", "seniorityLevel", "company", "roleHint", "engagementEvidence", "lastTouchDate", "sillageEnrichmentSummary", "fullenrichEnrichmentSummary"],
        additionalProperties: false,
      },
    },
    competitiveContext: {
      type: "object",
      properties: {
        competitorsNamed: { type: "array", items: { type: "string" } },
        marketSignals: { type: "array", items: { type: "string" } },
      },
      required: ["competitorsNamed", "marketSignals"],
      additionalProperties: false,
    },
    gapFindings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "<dealId>-<dimension>, e.g. deal-003-competition" },
          dimension: { type: "string" },
          evidenceTier: { type: "string", enum: ["documented_gap", "evidence_conflict", "inferred_hypothesis"] },
          statement: { type: "string" },
          evidenceCitations: {
            type: "array",
            items: {
              type: "object",
              properties: { source: { type: "string" }, ref: { type: "string" }, quote: { type: "string" } },
              required: ["source", "ref", "quote"],
              additionalProperties: false,
            },
          },
          confidence: { type: "number" },
        },
        required: ["id", "dimension", "evidenceTier", "statement", "evidenceCitations", "confidence"],
        additionalProperties: false,
      },
    },
    openQuestionsForFeedback: {
      type: "array",
      items: {
        type: "object",
        properties: { gapFindingId: { type: "string" }, question: { type: "string" } },
        required: ["gapFindingId", "question"],
        additionalProperties: false,
      },
    },
  },
  required: ["claimUnderReview", "stakeholderMap", "competitiveContext", "gapFindings", "openQuestionsForFeedback"],
  additionalProperties: false,
};

function buildSystemPrompt(framework, addOnFramework) {
  return `You are the evidence-gathering agent in StopMortem, a post-mortem system for lost B2B sales deals.

Your job in this session is ONLY to build a complete, evidence-backed portrait of one lost deal. You do NOT rank root causes, propose remedial actions, or decide what caused the loss — that happens in a separate later stage. Your output is diagnostic evidence, not a conclusion.

Treat the deal's recorded "closed lost reason" as a claim to verify against the evidence, not as ground truth.

You have tools to enrich companies and people via Sillage and FullEnrich — use them. Specifically:
- Enrich the deal's own company and any named competitors.
- For every stakeholder known only by title (no name recorded), try to resolve who they actually are — use fullenrich_reverse_email if an email address for them appears in the evidence, or fullenrich_lookup_person if a name is mentioned elsewhere.
- Use fullenrich_search_companies for competitive/market-landscape context on named competitors.
- sillage_workspace_signals and sillage_persona_context are available but this workspace's signals/persona may be configured for a completely different account, industry, or region than this deal. Before using anything from these two tools, check that the result actually names or clearly concerns this deal's own company or a company explicitly named in this deal's evidence (competitorsNamed). If it doesn't — e.g. it's about an unrelated industry, an unrelated persona, or a different company entirely — do not include it, don't write analysis about that unrelated company, and just note in marketSignals that no relevant signal was found. Never substitute an unrelated company's profile for this deal's own company.

Call each distinct tool+input combination AT MOST ONCE per session — do not repeat an identical call (same tool, same arguments) hoping for a different result. Call tools as many times as genuinely useful, but never redundantly.

STRICT RULE for competitiveContext.marketSignals: every entry must be genuinely EXTERNAL information that came from an actual Sillage or FullEnrich tool call you made THIS session — never restate a fact already given to you in the deal's own CRM export (meddpiccNotes, activityTimeline, emails, proposal) as if it were a "market signal," and never prefix an entry with a tool's name (e.g. "Sillage: ...") unless that exact tool actually returned that content in this session's toolCallLog. The deal's own stated pain point, budget, or internal notes are evidence for gapFindings, not market signals — do not duplicate them into marketSignals under a fake external label. If no tool call produced anything genuinely external and relevant, marketSignals should just say so plainly (e.g. "No relevant external market signals found") with no fabricated attribution.

${buildGapScanInstructions(framework)}
${addOnFramework ? `\n${buildAddOnInstructions(addOnFramework)}\n` : ""}
Use "<dealId>-<dimension>" as each finding's id (e.g. "deal-003-competition") so downstream feedback fixtures can reference it deterministically.

Keep the final answer compact: summarize tool results into a few key facts (sillageEnrichmentSummary / fullenrichEnrichmentSummary) rather than embedding raw tool output, and keep evidenceCitations quotes short.`;
}

/** In-run memoization key — same tool + same args within one Stage 1 session never needs to hit the API twice. */
function callKey(name, input) {
  return `${name}:${JSON.stringify(input)}`;
}

export async function runStage1Evidence(deal, framework, addOnFramework = null) {
  const activeFrameworks = addOnFramework ? [framework, addOnFramework] : [framework];
  const client = getAnthropicClient();
  const system = buildSystemPrompt(framework, addOnFramework);
  const toolCallLog = [];
  const callCache = new Map();

  let messages = [
    {
      role: "user",
      content: `Here is the full CRM export for this lost deal. Build the evidence portrait.\n\n${JSON.stringify(deal, null, 2)}`,
    },
  ];

  let finalParsed = null;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: STAGE1_MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system,
      tools: toolDefinitions,
      output_config: { format: { type: "json_schema", schema: DEAL_PORTRAIT_OUTPUT_SCHEMA } },
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

    if (response.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
      if (response.stop_reason === "max_tokens") {
        throw new Error(`Stage 1 hit max_tokens before finishing its final answer for deal ${deal.dealId} — increase max_tokens or shorten the required output.`);
      }
      const textBlock = response.content.find((b) => b.type === "text");
      try {
        finalParsed = JSON.parse(textBlock.text);
      } catch (err) {
        throw new Error(
          `Stage 1 final answer failed to parse for deal ${deal.dealId}. stop_reason=${response.stop_reason}, text length=${textBlock?.text?.length ?? 0}, parse error: ${err.message}. Last 200 chars: ${JSON.stringify(textBlock?.text?.slice(-200))}`
        );
      }
      break;
    }

    // Dispatch every tool call in this turn concurrently — Claude may request
    // several independent lookups in one response; there's no reason to
    // serialize them. Same-key calls (identical tool + identical args) within
    // this run reuse the cached result instead of repeating the HTTP call.
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const dispatch = toolDispatch[block.name];
        const timestampIso = new Date().toISOString();
        const key = callKey(block.name, block.input);

        if (callCache.has(key)) {
          const cached = callCache.get(key);
          toolCallLog.push({
            tool: block.name,
            argsSummary: JSON.stringify(block.input),
            resultSummary: `(cached) ${JSON.stringify(cached).slice(0, 200)}`,
            timestampIso,
          });
          return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(cached) };
        }

        try {
          const result = dispatch ? await dispatch(block.input) : { error: `Unknown tool "${block.name}"` };
          callCache.set(key, result);
          toolCallLog.push({
            tool: block.name,
            argsSummary: JSON.stringify(block.input),
            resultSummary: JSON.stringify(result).slice(0, 500),
            timestampIso,
          });
          return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) };
        } catch (err) {
          toolCallLog.push({ tool: block.name, argsSummary: JSON.stringify(block.input), resultSummary: `ERROR: ${err.message}`, timestampIso });
          return { type: "tool_result", tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true };
        }
      })
    );
    messages.push({ role: "user", content: toolResults });
  }

  if (finalParsed === null) {
    throw new Error(`Stage 1 exceeded ${MAX_ITERATIONS} tool-calling iterations without a final answer for deal ${deal.dealId}`);
  }

  validateGapFindings(finalParsed.gapFindings, activeFrameworks);

  const findingsWithFrameworkTag = tagFindingsWithFramework(finalParsed.gapFindings, activeFrameworks);
  const findingsWithNextStep = findingsWithFrameworkTag.map((f) => ({
    ...f,
    ...classifyNextStep(f, deal.deal),
  }));
  const findingsWithScore = scoreAllFindings(findingsWithNextStep, activeFrameworks);

  const stakeholderMap = finalParsed.stakeholderMap.map((s) => ({
    name: s.name,
    title: s.title,
    seniorityLevel: s.seniorityLevel,
    company: s.company,
    roleHint: s.roleHint,
    engagementEvidence: s.engagementEvidence,
    lastTouchDate: s.lastTouchDate,
    enrichment: { sillage: s.sillageEnrichmentSummary, fullenrich: s.fullenrichEnrichmentSummary },
  }));

  return {
    dealId: deal.dealId,
    framework: { id: framework.id, version: "1.0" },
    addOnFramework: addOnFramework ? { id: addOnFramework.id, label: addOnFramework.label } : null,
    generatedAt: new Date().toISOString(),
    claimUnderReview: finalParsed.claimUnderReview,
    stakeholderMap,
    competitiveContext: finalParsed.competitiveContext,
    gapFindings: findingsWithScore,
    openQuestionsForFeedback: finalParsed.openQuestionsForFeedback ?? [],
    toolCallLog,
  };
}
