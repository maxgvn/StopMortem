export function renderMarkdown(postmortem, portrait) {
  const lines = [];
  lines.push(`# Post-Mortem — ${postmortem.dealId}`);
  lines.push("");
  lines.push(`**Claim under review:** ${portrait.claimUnderReview.value} _(${portrait.claimUnderReview.note})_`);
  lines.push("");
  lines.push("## Summary");
  lines.push(postmortem.summary);
  lines.push("");
  lines.push("## Ranked Causes");
  for (const cause of postmortem.rankedCauses) {
    const finding = portrait.gapFindings.find((f) => f.id === cause.gapFindingId);
    lines.push(`### ${cause.rank}. ${finding?.dimension ?? cause.gapFindingId} (score: ${cause.score})`);
    lines.push(`_Evidence tier: ${finding?.evidenceTier ?? "unknown"}_`);
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
  for (const action of postmortem.actions) {
    lines.push(`- **[${action.category}]** ${action.description} _(from: ${action.sourceGapFindingIds.join(", ")})_`);
  }
  lines.push("");
  if (postmortem.speculativeHypotheses?.length) {
    lines.push("## Speculative Hypotheses (not actioned — unconfirmed)");
    for (const h of postmortem.speculativeHypotheses) {
      lines.push(`- **${h.dimension}**: ${h.statement} _(confidence: ${h.confidence})_`);
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
