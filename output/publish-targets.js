/**
 * Deterministic, code-generated — not LLM output. Shows where this post-mortem
 * would distribute in a real GTM stack. Only "Local file" is real in this
 * build; everything else is explicitly marked simulated (HubSpot is fully
 * faked — see DATA-SOURCES.md) rather than pretended into looking connected.
 */
export function buildPublishTargets({ location, dealId }) {
  return [
    { target: "Local file", status: "done", simulated: false, detail: location },
    {
      target: "HubSpot (deal record)",
      status: "simulated",
      simulated: true,
      detail: `Would write this summary + actions as a note on the ${dealId} deal record. Not a real integration in this build — HubSpot is fully faked (see DATA-SOURCES.md).`,
    },
    {
      target: "Slack (#sales-team)",
      status: "simulated",
      simulated: true,
      detail: "Would post the summary and top ranked cause to the team channel.",
    },
    {
      target: "Notion (recurring-causes log)",
      status: "simulated",
      simulated: true,
      detail: "Would append this deal's non-speculative causes to the v2 cross-deal playbook (see Roadmap in README.md).",
    },
  ];
}
