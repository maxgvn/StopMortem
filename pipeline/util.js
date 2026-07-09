export function extractJson(text) {
  const stripped = text.trim().replace(/^```(?:json)?\n?/i, "").replace(/```$/, "");
  return JSON.parse(stripped);
}
