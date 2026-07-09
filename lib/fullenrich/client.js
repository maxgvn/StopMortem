function baseUrl() {
  return process.env.FULLENRICH_API_BASE || "https://app.fullenrich.com/api/v2";
}

async function request(path, { method = "GET", body } = {}) {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.FULLENRICH_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`FullEnrich ${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

export function verifyKey() {
  return request("/account/keys/verify");
}

export function lookupCompany(body) {
  return request("/company/lookup", { method: "POST", body });
}

export function lookupPerson(body) {
  return request("/people/lookup", { method: "POST", body });
}

/** Confirmed-real filter fields on SearchCompaniesRequest: domains, industries, specialties — each a StringFilters array of {value}. */
function toStringFilters(values) {
  return values?.length ? values.map((value) => ({ value })) : undefined;
}

export function searchCompanies({ domains, industries, specialties, limit } = {}) {
  const body = {
    domains: toStringFilters(domains),
    industries: toStringFilters(industries),
    specialties: toStringFilters(specialties),
  };
  if (limit) body.limit = limit;
  return request("/company/search", { method: "POST", body });
}

export function submitContactEnrichBulk(body) {
  return request("/contact/enrich/bulk", { method: "POST", body });
}

export function getContactEnrichBulk(id) {
  return request(`/contact/enrich/bulk/${id}`);
}

export function submitReverseEmailBulk(body) {
  return request("/contact/reverse/email/bulk", { method: "POST", body });
}

export function getReverseEmailBulk(id) {
  return request(`/contact/reverse/email/bulk/${id}`);
}
