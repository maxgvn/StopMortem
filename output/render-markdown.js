export function renderMarkdown(postmortem, portrait) {
  const lines = [];
  lines.push(`# Post-Mortem — ${postmortem.dealId}`);
  lines.push("");
  lines.push(`**Claim under review:** ${portrait.claimUnderReview.value} _(${portrait.claimUnderReview.note})_`);
  lines.push("");
  lines.push("## Summary");
  lines.push(postmortem.summary);
  lines.push("");

  lines.push("## What happens next");
  for (const [category, items] of Object.entries(postmortem.nextStepsRollup ?? {})) {
    if (items.length === 0) continue;
    lines.push(`- **${category}** (${items.length}): ${items.map((i) => i.dimension).join(", ")}`);
  }
  lines.push("");

  lines.push("## Ranked Causes");
  for (const cause of postmortem.rankedCauses) {
    const finding = portrait.gapFindings.find((f) => f.id === cause.gapFindingId);
    lines.push(`### ${cause.rank}. ${finding?.dimension ?? cause.gapFindingId} (score: ${cause.score})`);
    lines.push(`_Evidence tier: ${finding?.evidenceTier ?? "unknown"} | Next step: ${finding?.recommendedNextStepCategory ?? "unknown"}_`);
    lines.push("");
    lines.push(cause.explanation);
    if (cause.evidenceCitations?.length) {
      lines.push("");
      lines.push("Citations:");
      for (const c of cause.evidenceCitations) {
        lines.push(`- [${c.source}] ${c.ref}${c.quote ? `: "${c.quote}"` : ""}`);
      }
    }
    lines.push("");
  }

  lines.push("## Remedial Actions");
  const actionsByCategory = new Map();
  for (const action of postmortem.actions) {
    if (!actionsByCategory.has(action.category)) actionsByCategory.set(action.category, []);
    actionsByCategory.get(action.category).push(action);
  }
  for (const [category, actions] of actionsByCategory) {
    lines.push(`### ${category}`);
    for (const action of actions) {
      lines.push(`- ${action.description} _(from: ${action.sourceGapFindingIds.join(", ")})_`);
    }
  }
  lines.push("");

  if (postmortem.departmentInsights?.length) {
    lines.push("## By Department");
    for (const d of postmortem.departmentInsights) {
      lines.push(`- **${d.department}:** ${d.insight}`);
    }
    lines.push("");
  }

  if (postmortem.speculativeHypotheses?.length) {
    lines.push("## Speculative Hypotheses (not actioned — unconfirmed)");
    for (const h of postmortem.speculativeHypotheses) {
      lines.push(`- **${h.dimension}**: ${h.statement} _(confidence: ${h.confidence})_`);
    }
    lines.push("");
  }

  if (postmortem.recoveryNote) {
    lines.push("## Recovery Note (not a plan — an aside)");
    lines.push(postmortem.recoveryNote);
    lines.push("");
  }

  if (postmortem.publishTargets?.length) {
    lines.push("## Published To");
    for (const t of postmortem.publishTargets) {
      lines.push(`- **${t.target}** — ${t.simulated ? "simulated" : "done"}: ${t.detail}`);
    }
    lines.push("");
  }

  const addonFindings = portrait.addOnFramework
    ? portrait.gapFindings.filter((f) => f.frameworkId === portrait.addOnFramework.id)
    : [];
  if (addonFindings.length > 0) {
    lines.push(`## ${portrait.addOnFramework.label} (add-on — pharma/life sciences only)`);
    for (const f of addonFindings) {
      lines.push(`- **${f.dimension}** [${f.evidenceTier}]: ${f.statement}`);
    }
    lines.push("");
  }

  lines.push("## Stakeholders");
  for (const s of portrait.stakeholderMap) {
    lines.push(`- **${s.name ?? "(unidentified)"}** — ${s.title} @ ${s.company} — role: ${s.roleHint}`);
  }
  lines.push("");
  lines.push(`## Tool Call Log (${portrait.toolCallLog.length} calls)`);
  for (const t of portrait.toolCallLog) {
    lines.push(`- \`${t.tool}\`(${t.argsSummary}) @ ${t.timestampIso}`);
  }
  return lines.join("\n");
}
