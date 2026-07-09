import {
  addAccountToTargetList,
  getTargetListStatus,
  listTargetListAccounts,
  listNotFoundAccounts,
  getWorkspaceSignals,
  getPersona,
} from "./client.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enrichCompany({ domain, linkedin_url }) {
  await addAccountToTargetList({ domain, linkedinUrl: linkedin_url });

  const timeoutMs = 15000;
  const pollIntervalMs = 1500;
  const start = Date.now();
  let status = await getTargetListStatus();
  while (Date.now() - start < timeoutMs && status.state !== "completed" && status.state !== "failed") {
    await sleep(pollIntervalMs);
    status = await getTargetListStatus();
  }

  const list = await listTargetListAccounts({ page: 1, pageSize: 100 });
  const match = list.data.find(
    (a) =>
      (domain && a.company?.domain === domain) ||
      (domain && a.user_input?.domain === domain) ||
      (linkedin_url && a.user_input?.linkedin_url === linkedin_url)
  );

  if (!match) {
    return { found: false, ingestionStatus: status, note: "No match yet in the Top Account List; ingestion may still be in progress." };
  }
  return { found: true, ingestionStatus: status, account: match };
}

/** Claude tool-use definitions (Sillage) — a focused v1 subset, not every candidate endpoint. */
export const sillageToolDefinitions = [
  {
    name: "sillage_enrich_company",
    description:
      "Enrich a company by domain or LinkedIn URL via Sillage's Top Account List — returns firmographics (employee count, logo, site). Use for the deal's own company and any named competitor. Handles async ingestion internally; may take a few seconds.",
    input_schema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Company domain, e.g. 'box.com'" },
        linkedin_url: { type: "string", description: "Company LinkedIn URL" },
      },
    },
  },
  {
    name: "sillage_check_not_found",
    description: "List accounts recently submitted to Sillage's Top Account List that could not be enriched — use to check enrichment coverage gaps.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "sillage_workspace_signals",
    description:
      "Fetch this Sillage workspace's market/intent signals. Note: this workspace's configured persona may be tuned for a different use case than this deal's industry — treat any results as a candidate signal to evaluate for relevance, not an authoritative match.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "sillage_persona_context",
    description: "Read-only lookup of this Sillage workspace's configured ICP/persona definition — use to understand whose signals sillage_workspace_signals is actually tuned for before relying on it.",
    input_schema: { type: "object", properties: {} },
  },
];

export const sillageToolDispatch = {
  sillage_enrich_company: (input) => enrichCompany(input),
  sillage_check_not_found: () => listNotFoundAccounts(),
  sillage_workspace_signals: () => getWorkspaceSignals(),
  sillage_persona_context: () => getPersona(),
};
