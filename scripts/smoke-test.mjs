import "dotenv/config";
import { sillageToolDispatch } from "../lib/sillage/tools.js";
import { fullEnrichToolDispatch } from "../lib/fullenrich/tools.js";

console.log("=== Sillage: enrich box.com ===");
console.dir(await sillageToolDispatch.sillage_enrich_company({ domain: "box.com" }), { depth: null });

console.log("\n=== FullEnrich: lookup company box.com ===");
console.dir(await fullEnrichToolDispatch.fullenrich_lookup_company({ domain: "box.com" }), { depth: null });

console.log("\n=== FullEnrich: lookup person Aaron Levie @ box.com ===");
console.dir(
  await fullEnrichToolDispatch.fullenrich_lookup_person({ person_name: "Aaron Levie", company_domain: "box.com" }),
  { depth: null }
);

console.log("\n=== FullEnrich: search companies (industry=Technology, Information and Internet) ===");
console.dir(
  await fullEnrichToolDispatch.fullenrich_search_companies({ industries: ["Technology, Information and Internet"], limit: 3 }),
  { depth: null }
);

console.log("\n=== FullEnrich: reverse email lookup (synthetic address, expect not-found) ===");
console.dir(await fullEnrichToolDispatch.fullenrich_reverse_email({ email: "unidentified.stakeholder.stopmortem@box.com" }), { depth: null });
