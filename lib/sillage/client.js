const V2_PREFIX = "/api/v2";
const V1_PREFIX = "/api/v1";

function baseUrl() {
  return process.env.SILLAGE_API_BASE || "https://api.getsillage.com";
}

async function request(prefix, path, { method = "GET", body } = {}) {
  const url = `${baseUrl()}${prefix}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.SILLAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.error?.message || res.statusText;
    throw new Error(`Sillage ${method} ${prefix}${path} -> ${res.status} ${message}`);
  }
  return data;
}

export function addAccountToTargetList({ domain, linkedinUrl } = {}) {
  const account = {};
  if (domain) account.domain = domain;
  if (linkedinUrl) account.linkedin_url = linkedinUrl;
  return request(V2_PREFIX, "/top-account-list/accounts", {
    method: "POST",
    body: { accounts: [account] },
  });
}

export function getTargetListStatus() {
  return request(V2_PREFIX, "/top-account-list/status");
}

export function listTargetListAccounts({ page = 1, pageSize = 25 } = {}) {
  return request(V2_PREFIX, `/top-account-list/accounts?page=${page}&page_size=${pageSize}`);
}

export function listNotFoundAccounts() {
  return request(V2_PREFIX, "/top-account-list/accounts/not-found");
}

export function getWorkspaceSignals() {
  return request(V1_PREFIX, "/workspace/signals");
}

export function queryMarketContent(body) {
  return request(V2_PREFIX, "/contents/query", { method: "POST", body });
}

export function getPersona() {
  return request(V2_PREFIX, "/persona");
}

export function putPersona(body) {
  return request(V2_PREFIX, "/persona", { method: "PUT", body });
}
