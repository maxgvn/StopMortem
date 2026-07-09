/**
 * Future real integration — not implemented in v1 (HubSpot is fully faked; see
 * fixtures/). When a real HubSpot writeback is built, it should implement the
 * same WritebackAdapter contract as local-file-adapter.js (see interface.js)
 * so pipeline/index.js doesn't need to change: write the post-mortem summary
 * and actions onto the HubSpot deal record (note vs. custom properties —
 * shape still to be decided with the user).
 */
export async function publish() {
  throw new Error("hubspot-adapter is not implemented — v1 uses local-file-adapter.js");
}
