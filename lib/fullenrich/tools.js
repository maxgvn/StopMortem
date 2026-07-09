import {
  lookupCompany,
  lookupPerson,
  searchCompanies,
  submitContactEnrichBulk,
  getContactEnrichBulk,
  submitReverseEmailBulk,
  getReverseEmailBulk,
} from "./client.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntilDone(getFn, id, { timeoutMs = 30000, pollIntervalMs = 2000 } = {}) {
  const start = Date.now();
  let result = await getFn(id);
  while (Date.now() - start < timeoutMs && result.status === "IN_PROGRESS") {
    await sleep(pollIntervalMs);
    result = await getFn(id);
  }
  return result;
}

async function enrichContact(input) {
  const submitted = await submitContactEnrichBulk({
    name: `stopmortem-${Date.now()}`,
    data: [
      {
        first_name: input.first_name,
        last_name: input.last_name,
        company: input.company_domain,
        domain: input.company_domain,
        linkedin_url: input.linkedin_url,
      },
    ],
  });
  return pollUntilDone(getContactEnrichBulk, submitted.enrichment_id);
}

async function reverseEmail(input) {
  const submitted = await submitReverseEmailBulk({
    name: `stopmortem-${Date.now()}`,
    data: [{ email: input.email }],
  });
  return pollUntilDone(getReverseEmailBulk, submitted.enrichment_id);
}

/**
 * Claude tool-use definitions (FullEnrich).
 *
 * NOTE: `people/search` (bulk filter-by-seniority search) is NOT wired in here.
 * Its request schema is undocumented and didn't respond to type-probing during
 * implementation (unlike company/search, which has a typed, discoverable schema) —
 * ~25 field-name/shape guesses all returned a generic "filters.empty" 400 with no
 * signal pointing to the real shape. Dropped for v1 rather than shipped broken.
 * Stakeholder resolution instead relies on `fullenrich_lookup_person` (name + company
 * domain — confirmed working) and `fullenrich_reverse_email` (confirmed working) for
 * roles known only by an email address in CRM activity, not by name.
 */
export const fullEnrichToolDefinitions = [
  {
    name: "fullenrich_lookup_company",
    description: "Look up a company by domain. Synchronous. Returns description, industry, headcount, locations.",
    input_schema: {
      type: "object",
      properties: { domain: { type: "string" } },
      required: ["domain"],
    },
  },
  {
    name: "fullenrich_lookup_person",
    description:
      "Look up a named person by their full name + company domain (or a LinkedIn profile URL). Synchronous. Returns seniority, job function, employment history — use this to confirm a named stakeholder's actual title/seniority.",
    input_schema: {
      type: "object",
      properties: {
        person_name: { type: "string" },
        company_domain: { type: "string", description: "Required alongside person_name" },
        person_professional_network_url: { type: "string", description: "Person's LinkedIn URL — alternative to person_name+company_domain" },
      },
    },
  },
  {
    name: "fullenrich_search_companies",
    description: "Search companies by domain/industry/specialty. Synchronous. Use for competitive/market-landscape context.",
    input_schema: {
      type: "object",
      properties: {
        domains: { type: "array", items: { type: "string" } },
        industries: { type: "array", items: { type: "string" } },
        specialties: { type: "array", items: { type: "string" } },
        limit: { type: "integer", default: 10 },
      },
    },
  },
  {
    name: "fullenrich_reverse_email",
    description:
      "Identify the person and company behind an email address seen in CRM notes/activity/emails but not otherwise identified by name. THE primary tool for resolving 'title-only' stakeholders (e.g. 'IT Director' with no name recorded) when an email address for them exists in the evidence. Async; polled internally.",
    input_schema: {
      type: "object",
      properties: { email: { type: "string" } },
      required: ["email"],
    },
  },
  {
    name: "fullenrich_enrich_contact",
    description:
      "Find verified work email/phone for a named stakeholder (first_name+last_name+company_domain, or linkedin_url) — corroborates whether direct contact info existed for this deal's real decision-makers. Async; polled internally.",
    input_schema: {
      type: "object",
      properties: {
        first_name: { type: "string" },
        last_name: { type: "string" },
        company_domain: { type: "string" },
        linkedin_url: { type: "string" },
      },
    },
  },
];

export const fullEnrichToolDispatch = {
  fullenrich_lookup_company: (input) => lookupCompany({ domain: input.domain }),
  fullenrich_lookup_person: (input) =>
    lookupPerson({
      person_name: input.person_name,
      company_domain: input.company_domain,
      person_professional_network_url: input.person_professional_network_url,
    }),
  fullenrich_search_companies: (input) =>
    searchCompanies({
      domains: input.domains,
      industries: input.industries,
      specialties: input.specialties,
      limit: input.limit ?? 10,
    }),
  fullenrich_reverse_email: (input) => reverseEmail(input),
  fullenrich_enrich_contact: (input) => enrichContact(input),
};
