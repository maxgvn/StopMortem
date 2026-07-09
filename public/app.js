const dealListEl = document.getElementById("dealList");
const emptyStateEl = document.getElementById("emptyState");
const dealViewEl = document.getElementById("dealView");
const statusStripEl = document.getElementById("statusStrip");
const crumbsEl = document.getElementById("crumbs");

// Per-deal outcome-character accent for the sidebar's left border — a fixed
// categorical tag per fixture (not derived live from a run), same idea as the
// pharma add-on's violet: identity, not severity. Won deals get the "clean" green.
const DEAL_ACCENT = {
  "deal-001": "#fab219", // Box — documented qualification gap (amber)
  "deal-002": "#a56a00", // Asana — evidence conflict / pricing (deep amber)
  "deal-003": "#4a3aa7", // Medidata — pharma / inferred-to-confirmed (violet)
  "deal-004": "#d03b3b", // Datadog — high-value external loss (red)
  "deal-005": "#0ca30c", // GitLab — clean external loss (green)
  "deal-006": "#0ca30c", // Airtable — won
  "deal-007": "#0ca30c", // Zapier — won
};

let deals = [];
let activeDealId = null;
let currentDeal = null;
let runResult = null; // { postmortem, portrait, finalPortrait, feedbackApplied, feedbackInput, location }
let runStatus = "idle"; // idle | running | completed | error
let runError = null;
let runMeta = null; // { triggeredBy, startedAt, completedAt } — from the current/latest run, for the header's "last run" line
let partialPortrait = null; // Stage 1's portrait, visible as soon as it's ready — before Stage 2/3 finish
let runStage = null; // "evidence_gathering" | "synthesizing" — which phase of a running pipeline is active
let activeTab = "stage1";
let pollHandle = null;
let manualEntries = []; // [{ gapFindingId, dimension, clientConfirms, clientDisputes, note }] — staged, not yet submitted
// gapFindingId -> { assignee, status: "assigned" | "waived" } — local-only tracker state.
// "waived" hides the item from the outstanding count in this tab and in Stage 3's tracker.
// Actually resolving a finding's evidence happens via submitAssignFeedback(), which calls the
// real feedback API and re-runs Stage 2/3 — waiving never touches real evidence tiers.
let assignedItems = {};

const LIST_CAP = 5;

// Fake internal roster for the assign flow — a name + small avatar, not a generic role label.
const TEAM_ROSTER = [
  { name: "Jane Doe", role: "Account Executive" },
  { name: "Priya Shah", role: "Sales Manager" },
  { name: "Marcus Webb", role: "Pre-Sales" },
  { name: "Sam Okafor", role: "Product" },
  { name: "Elena Torres", role: "Legal/Compliance" },
];

// Heuristic mapping from a MEDDPICC(+add-on) dimension to the department it's most
// relevant to — purely a frontend label so "Ranked causes" can lead with who owns it,
// and so the assign flow can default to a plausible owner instead of always the rep.
const DIMENSION_DEPARTMENT = {
  metrics: "Pre-Sales",
  economicBuyer: "Sales",
  decisionCriteria: "Pre-Sales",
  decisionProcess: "Sales",
  paperProcess: "Sales",
  identifyPain: "Pre-Sales",
  champion: "Sales",
  competition: "Product",
  cfr11Compliance: "Legal/Compliance",
  dataResidency: "Legal/Compliance",
  validationDocumentation: "Legal/Compliance",
  securityReviewSignoff: "Legal/Compliance",
};

const PERSON_BY_DEPARTMENT = {
  Sales: "Priya Shah",
  "Pre-Sales": "Marcus Webb",
  Product: "Sam Okafor",
  "Legal/Compliance": "Elena Torres",
};

function departmentFor(dimension) {
  return DIMENSION_DEPARTMENT[dimension] ?? "Sales";
}

function defaultAssigneeFor(dimension) {
  return PERSON_BY_DEPARTMENT[departmentFor(dimension)] ?? TEAM_ROSTER[0].name;
}

function firstSentence(text) {
  if (!text) return "";
  const match = text.match(/^.*?[.!?](?=\s|$)/);
  if (match) return match[0];
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

/** A text block past `limit` chars shows only its first sentence, with the rest behind a fold. */
function renderTruncated(text, { limit = 220, cssClass = "" } = {}) {
  if (!text) return `<p class="${cssClass}"></p>`;
  if (text.length <= limit) return `<p class="${cssClass}">${escapeHtml(text)}</p>`;
  return `
    <p class="${cssClass}">${escapeHtml(firstSentence(text))}</p>
    <details class="fold-more"><summary>Show full text</summary><p class="${cssClass}">${escapeHtml(text)}</p></details>`;
}

const TRIGGER_LABEL = {
  crm_webhook: "Auto-triggered from HubSpot",
  manual: "Manually triggered",
  manual_feedback: "Feedback re-run",
};

function triggerLabel(triggeredBy) {
  return TRIGGER_LABEL[triggeredBy] ?? triggeredBy ?? "Unknown trigger";
}

function relativeTime(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString();
}

const TIER_BADGE = {
  documented_gap: { cls: "badge-good", label: "Documented gap" },
  evidence_conflict: { cls: "badge-warning", label: "Evidence conflict" },
  inferred_hypothesis: { cls: "badge-muted", label: "Inferred hypothesis" },
};

const NEXT_STEP_BADGE = {
  no_further_investigation_needed: { cls: "badge-good", label: "No further investigation" },
  some_internal_followup_needed: { cls: "badge-warning", label: "Internal follow-up" },
  client_call_needed: { cls: "badge-serious", label: "Client call needed" },
  full_third_party_review: { cls: "badge-critical", label: "Third-party review" },
  waived: { cls: "badge-muted", label: "Waived" },
};

/** True once someone has locally marked this finding as "no follow-up needed" — doesn't touch real evidence tiers. */
function isWaived(gapFindingId) {
  return assignedItems[gapFindingId]?.status === "waived";
}

/**
 * Splits a raw nextStepsRollup into the buckets minus anything waived locally, plus a
 * separate "waived" bucket — so Stage 3's tracker reflects local waives without a rerun.
 */
function buildAdjustedRollup(rollup) {
  const adjusted = {};
  const waived = [];
  for (const [category, items] of Object.entries(rollup ?? {})) {
    if (category === "no_further_investigation_needed") {
      adjusted[category] = [...items];
      continue;
    }
    const kept = [];
    for (const item of items) {
      if (isWaived(item.gapFindingId)) waived.push(item);
      else kept.push(item);
    }
    adjusted[category] = kept;
  }
  if (waived.length > 0) adjusted.waived = waived;
  return adjusted;
}

const NEXT_STEP_ROLLUP_LABELS = {
  full_third_party_review: "Third-party review ordered",
  client_call_needed: "Client outreach needed",
  some_internal_followup_needed: "Internal follow-up needed",
  no_further_investigation_needed: "Confirmed — no action needed",
};

function badge(map, key) {
  const spec = map[key] ?? { cls: "badge-muted", label: key ?? "unknown" };
  return `<span class="badge ${spec.cls}">${escapeHtml(spec.label)}</span>`;
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtMoney(n) {
  return `$${Number(n).toLocaleString()}`;
}

function ownerName(ownerId) {
  if (!ownerId) return "Unassigned";
  return ownerId
    .replace(/^rep_/, "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function initials(name) {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/** Renders `items` capped to LIST_CAP by score, with the rest behind a fold-out. */
function renderCappedList(items, renderItem, opts = {}) {
  const sorted = opts.sortByScore === false ? items : [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const top = sorted.slice(0, LIST_CAP);
  const rest = sorted.slice(LIST_CAP);
  let html = top.map(renderItem).join("");
  if (rest.length > 0) {
    html += `
      <details class="fold-more">
        <summary>Show ${rest.length} more (lower-scoring)</summary>
        ${rest.map(renderItem).join("")}
      </details>`;
  }
  return html;
}

// ---- Data loading ----

async function loadDeals() {
  deals = await fetch("/api/deals").then((r) => r.json());
  renderSidebar();
  // Land on a populated deal by default rather than an empty state — the
  // server auto-triggers a couple of runs at startup (see server.js), so
  // the first deal is usually already running or complete by the time this loads.
  if (!activeDealId && deals.length > 0) {
    selectDeal(deals[0].dealId);
  }
}

async function loadStatusStrip() {
  try {
    const status = await fetch("/api/status").then((r) => r.json());
    statusStripEl.innerHTML = `
      <div class="status-row"><span class="status-dot ${status.sillage}"></span>Sillage — ${status.sillage === "connected" ? "connected" : status.sillage}</div>
      <div class="status-row"><span class="status-dot ${status.fullenrich}"></span>FullEnrich — ${status.fullenrich === "connected" ? "connected" : status.fullenrich}</div>
      <div class="status-row"><span class="status-dot ${status.hubspot}"></span>HubSpot — not integrated (fixture data)</div>
    `;
  } catch {
    statusStripEl.innerHTML = `<div class="status-row"><span class="status-dot error"></span>Status check failed</div>`;
  }
}

// ---- Sidebar ----

function renderSidebar() {
  dealListEl.innerHTML = deals
    .map((d) => {
      const running = d.activeRun?.status === "running";
      const isWon = d.stage === "closed_won";
      return `
    <div class="deal-card ${d.dealId === activeDealId ? "active" : ""}" data-deal-id="${d.dealId}" style="--deal-accent: ${DEAL_ACCENT[d.dealId] ?? "var(--text-muted)"};">
      <div class="deal-card-name">
        ${escapeHtml(d.dealName)}
        ${isWon ? `<span class="badge badge-good deal-card-badge">Won</span>` : ""}
        ${d.accountTier === "strategic" ? `<span class="badge badge-strategic deal-card-badge">Strategic</span>` : ""}
      </div>
      <div class="deal-card-meta">
        <span class="deal-card-amount">${fmtMoney(d.amount)}</span>
        <span>·</span>
        <span>${escapeHtml(d.company)}</span>
        ${running ? `<span class="running-dot"></span><span class="deal-card-running-label">Running</span>` : ""}
      </div>
      ${
        d.activeRun && !running
          ? `<div class="deal-card-trigger">${escapeHtml(triggerLabel(d.activeRun.triggeredBy))} · ${escapeHtml(relativeTime(d.activeRun.completedAt ?? d.activeRun.startedAt))}</div>`
          : ""
      }
    </div>`;
    })
    .join("");

  dealListEl.querySelectorAll(".deal-card").forEach((card) => {
    card.addEventListener("click", () => selectDeal(card.dataset.dealId));
  });
}

// ---- Deal selection ----

async function selectDeal(dealId) {
  stopPolling();
  activeDealId = dealId;
  runResult = null;
  runStatus = "idle";
  runError = null;
  runMeta = null;
  partialPortrait = null;
  runStage = null;
  activeTab = "stage1";
  renderSidebar();
  emptyStateEl.hidden = true;
  dealViewEl.hidden = false;

  currentDeal = await fetch(`/api/deals/${dealId}`).then((r) => r.json());
  crumbsEl.innerHTML = `<b>Deals</b><span>/</span><span>${escapeHtml(currentDeal.company.name)}</span>`;

  // Resume an in-progress or already-completed run for this deal, if one exists —
  // this is what makes navigating away and back not "lose" a run.
  const latest = await fetch(`/api/deals/${dealId}/latest-run`).then((r) => r.json());
  if (latest) {
    runMeta = { triggeredBy: latest.triggeredBy, startedAt: latest.startedAt, completedAt: latest.completedAt };
    if (latest.status === "running") {
      runStatus = "running";
      runStage = latest.stage;
      partialPortrait = latest.portrait;
      startPolling(latest.runId);
    } else if (latest.status === "completed") {
      runStatus = "completed";
      runResult = latest.result;
    } else if (latest.status === "error") {
      runStatus = "error";
      runError = latest.error;
    }
  }

  renderDealView();
}

// ---- Running a post-mortem ----

async function runPipeline(dealId, { waiveFeedback = false } = {}) {
  runStatus = "running";
  runError = null;
  runResult = null;
  partialPortrait = null;
  runStage = "evidence_gathering";
  renderDealView();

  try {
    const res = await fetch(`/api/deals/${dealId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ waiveFeedback }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Unknown error");
    startPolling(data.runId);
  } catch (err) {
    runStatus = "error";
    runError = err.message;
    renderDealView();
  }
}

function startPolling(runId) {
  stopPolling();
  pollHandle = setInterval(async () => {
    try {
      const run = await fetch(`/api/runs/${runId}`).then((r) => r.json());
      if (run.status === "running") {
        // Surface Stage 1's portrait (and the evidence_gathering -> synthesizing transition)
        // as soon as it shows up, without waiting for the whole pipeline to finish.
        const changed = run.stage !== runStage || (run.portrait && !partialPortrait);
        runStage = run.stage ?? runStage;
        if (run.portrait) partialPortrait = run.portrait;
        if (changed) renderDealView();
        return;
      }
      stopPolling();
      runStatus = run.status;
      runMeta = { triggeredBy: run.triggeredBy, startedAt: run.startedAt, completedAt: run.completedAt };
      if (run.status === "completed") runResult = run.result;
      if (run.status === "error") runError = run.error;
      partialPortrait = null;
      runStage = null;
      renderDealView();
      renderSidebar(); // clear the sidebar's running indicator for this deal
    } catch {
      // transient network error — keep polling, don't flip to an error state over one missed poll
    }
  }, 1800);
}

function stopPolling() {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
}

// Keep the sidebar's running indicators live even for deals other than the selected one
// (e.g. the server's own auto-triggered runs at startup, or a run on a deal you're not viewing).
setInterval(() => {
  if (!activeDealId) loadDeals();
}, 4000);

// ---- Main deal view ----

function renderDealView() {
  const isWon = currentDeal.deal.stage === "closed_won";
  const isPharma = currentDeal.meta.industry === "life_sciences_pharma";
  const accountTier = currentDeal.company.hubspot?.accountTier;
  const stages = currentDeal.deal.pipelineStagesReached ?? [];
  const deepestStageReached = stages[stages.length - 2] ?? stages[0]; // last stage before closed_won/closed_lost
  const owner = ownerName(currentDeal.deal.owner);
  const daysInPipeline = Math.round(
    (new Date(currentDeal.deal.closeDate) - new Date(currentDeal.deal.createdDate)) / 86400000
  );

  const bannerHtml =
    runStatus === "running"
      ? `<div class="running-banner">
          <div class="running-banner-top"><span class="spinner"></span>${
            runStage === "synthesizing" ? "Stage 2/3 — scoring &amp; synthesizing…" : "Stage 1 — gathering evidence…"
          }</div>
          <div class="running-banner-sub">${
            runStage === "synthesizing"
              ? "Evidence portrait is ready (see the tab below) — now ranking causes and writing the synthesis, ~10-20s."
              : "Real Sillage + FullEnrich tool calls in progress, ~20-70s. Safe to navigate away — this keeps running server-side."
          }</div>
          <div class="running-banner-progress"></div>
        </div>`
      : runStatus === "error"
      ? `<div class="running-banner error">
          <div class="running-banner-top">Run failed</div>
          <div class="running-banner-sub">${escapeHtml(runError)}</div>
        </div>`
      : "";

  const runControlsHtml = isWon
    ? `<p class="unchanged-note">This deal was won — there's no loss to analyze, so a post-mortem isn't applicable here.</p>`
    : `
    <div class="run-controls">
      <button class="run-btn" id="runBtn" ${runStatus === "running" ? "disabled" : ""}>Run post-mortem</button>
    </div>`;

  dealViewEl.innerHTML = `
    <div class="deal-header">
      <div class="deal-title-row">
        <h2>${escapeHtml(currentDeal.meta.dealName)}</h2>
        <span class="${isWon ? "pill-won" : "pill-lost"}">${isWon ? "Closed won" : "Closed lost"}</span>
      </div>
      <div class="deal-facts">
        <span class="owner"><span class="avatar avatar-sm">${escapeHtml(initials(owner))}</span>${escapeHtml(owner)}</span>
        <span class="sep">·</span>
        <span>Closed ${escapeHtml(currentDeal.deal.closeDate)}</span>
        <span class="sep">·</span>
        <span>${daysInPipeline} days in pipeline</span>
        ${
          runMeta?.startedAt
            ? `<span class="sep">·</span><span>Post-mortem: ${escapeHtml(triggerLabel(runMeta.triggeredBy))}, ${escapeHtml(relativeTime(runMeta.completedAt ?? runMeta.startedAt))}</span>`
            : ""
        }
      </div>
      <div class="deal-header-meta">
        <span class="deal-amount-hero">${fmtMoney(currentDeal.deal.amount)}</span>
        ${isWon ? "" : `<span class="badge badge-muted">Reached: ${escapeHtml(deepestStageReached)}</span>`}
        ${accountTier === "strategic" ? `<span class="badge badge-strategic">Strategic account</span>` : ""}
        ${isPharma ? `<span class="badge" style="background:var(--addon-accent-bg); color:var(--addon-accent);">Pharma/Life Sciences</span>` : ""}
        ${isWon ? `<span>Won: "${escapeHtml(currentDeal.deal.closedWonReason)}"</span>` : `<span>Stated reason: "${escapeHtml(currentDeal.deal.closedLostReason)}"</span>`}
      </div>
      ${runControlsHtml}
      ${bannerHtml}
    </div>
    ${runResult || partialPortrait ? renderTabs() : ""}
  `;

  if (!isWon) {
    document.getElementById("runBtn").addEventListener("click", () => runPipeline(currentDeal.dealId));
  }
  attachTabListeners();
}

// ---- Tabs ----

function renderTabs() {
  const portrait = runResult?.portrait ?? partialPortrait;
  const finalPortrait = runResult?.finalPortrait ?? null;
  const feedbackApplied = runResult?.feedbackApplied ?? false;
  const tabs = [
    { id: "stage1", label: "1. Evidence Portrait", count: portrait.gapFindings.length },
    { id: "stage2", label: "2. Follow-up", count: runResult ? (feedbackApplied ? "✓" : "–") : "…" },
    {
      id: "stage3",
      label: "3. Synthesis",
      count: finalPortrait ? finalPortrait.gapFindings.filter((f) => f.evidenceTier !== "inferred_hypothesis").length : "…",
    },
  ];

  return `
    <div class="tab-bar">
      ${tabs
        .map(
          (t) => `<button class="tab-btn ${activeTab === t.id ? "active" : ""}" data-tab="${t.id}">${t.label} <span class="tab-count">(${t.count})</span></button>`
        )
        .join("")}
    </div>
    <div id="tabContent">${renderActiveTab()}</div>
  `;
}

function switchTab(tabId) {
  activeTab = tabId;
  renderDealView();
}

function attachTabListeners() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
}

function renderActiveTab() {
  if (activeTab === "stage1") return renderStage1(runResult?.portrait ?? partialPortrait);
  if (!runResult) {
    return `<section class="stage tab-panel-header-omitted"><div class="stage-body">
      <p class="unchanged-note">Evidence gathering is done — scoring and synthesis are running now. This tab will populate automatically.</p>
    </div></section>`;
  }
  if (activeTab === "stage2") return renderStage2();
  return renderStage3();
}

// ---- Stage 1: Evidence Portrait ----

function renderStage1(p) {
  const isAddonFinding = (f) => p.addOnFramework && f.frameworkId === p.addOnFramework.id;
  const coreFindings = p.gapFindings.filter((f) => !isAddonFinding(f));
  const addonFindings = p.gapFindings.filter(isAddonFinding);

  const stakeholdersHtml = p.stakeholderMap
    .map(
      (s) => `
    <div class="stakeholder">
      <div>
        <div class="stakeholder-name">${escapeHtml(s.name ?? "(unidentified)")}</div>
        <div class="stakeholder-role">${escapeHtml(s.title)} · ${escapeHtml(s.roleHint)}</div>
        ${
          s.enrichment && (s.enrichment.sillage || s.enrichment.fullenrich)
            ? `<div class="enrichment-note">${escapeHtml(s.enrichment.fullenrich || s.enrichment.sillage)}</div>`
            : ""
        }
      </div>
    </div>`
    )
    .join("");

  const competitorsHtml =
    (p.competitiveContext?.competitorsNamed ?? []).map((c) => `<li>${escapeHtml(typeof c === "string" ? c : c.name)}</li>`).join("") ||
    "<li class=\"unchanged-note\">None named</li>";

  const signalsHtml =
    (p.competitiveContext?.marketSignals ?? []).map((s) => `<li>${escapeHtml(typeof s === "string" ? s : JSON.stringify(s))}</li>`).join("") ||
    "<li class=\"unchanged-note\">None surfaced</li>";

  const renderFinding = (f) => `
    <div class="finding">
      <div class="finding-top">
        <span class="finding-dimension">${escapeHtml(f.dimension)}</span>
        ${badge(TIER_BADGE, f.evidenceTier)}
        <span class="finding-score num">score ${f.score}</span>
      </div>
      <p class="finding-statement">${escapeHtml(f.statement)}</p>
      <div class="citations">
        ${f.evidenceCitations
          .map((c) => `<div class="citation"><span class="cite-source">${escapeHtml(c.source)}</span> — ${escapeHtml(c.quote || c.ref)}</div>`)
          .join("")}
      </div>
    </div>`;

  const toolLogHtml = p.toolCallLog
    .map((t) => `<div class="tool-log-item"><span class="mono">${escapeHtml(t.tool)}</span>(${escapeHtml(t.argsSummary)})</div>`)
    .join("");

  return `
  <section class="stage tab-panel-header-omitted">
    <div class="stage-body">
      <div class="claim-callout">
        <span class="claim-label">Claim under review</span>
        "${escapeHtml(p.claimUnderReview.value)}"
        <div class="claim-note">${escapeHtml(p.claimUnderReview.note)}</div>
      </div>

      <h4>Stakeholders</h4>
      ${stakeholdersHtml}

      <h4>Competitive context</h4>
      <ul>${competitorsHtml}</ul>
      <h4>Market signals</h4>
      <ul>${signalsHtml}</ul>

      <h4>Gap findings (${coreFindings.length}, showing top ${Math.min(LIST_CAP, coreFindings.length)} by score)</h4>
      ${renderCappedList(coreFindings, renderFinding)}

      ${
        addonFindings.length > 0
          ? `<div class="addon-section">
              <span class="addon-section-label">⚕ ${escapeHtml(p.addOnFramework.label)} — add-on (pharma/life sciences only)</span>
              ${renderCappedList(addonFindings, renderFinding)}
            </div>`
          : ""
      }

      <details class="tool-log" style="margin-top:16px;">
        <summary>Tool call log (${p.toolCallLog.length} calls)</summary>
        <div class="tool-log-list">${toolLogHtml}</div>
      </details>
    </div>
  </section>`;
}

// ---- Stage 2: Follow-up / Feedback ----

function renderStage2() {
  const { portrait, finalPortrait, feedbackApplied, feedbackInput } = runResult;
  const hasFeedback = deals.find((d) => d.dealId === currentDeal.dealId)?.hasFeedback;

  const before = new Map(portrait.gapFindings.map((f) => [f.id, f]));
  const upgraded = feedbackApplied ? finalPortrait.gapFindings.filter((f) => before.get(f.id)?.evidenceTier !== f.evidenceTier) : [];

  const diffHtml = upgraded
    .map((f) => {
      const prevTier = before.get(f.id)?.evidenceTier;
      const fbNote = f.evidenceCitations.find((c) => c.source === "client_feedback")?.quote;
      return `
      <div class="diff-row">
        <span class="finding-dimension">${escapeHtml(f.dimension)}</span>
        ${badge(TIER_BADGE, prevTier)}
        <span class="diff-arrow">→</span>
        ${badge(TIER_BADGE, f.evidenceTier)}
      </div>
      ${fbNote ? `<div class="citation client-feedback"><span class="cite-source">client_feedback</span> — ${escapeHtml(fbNote)}</div>` : ""}`;
    })
    .join("");

  // Findings whose deterministic next-step category is anything other than "no further
  // investigation needed" — these are the outstanding items a rep/manager should assign.
  // Ranked by the same deterministic score as "Ranked causes," most important first.
  const outstanding = finalPortrait.gapFindings
    .filter((f) => f.recommendedNextStepCategory !== "no_further_investigation_needed")
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const stillOpenCount = outstanding.filter((f) => !isWaived(f.id)).length;

  const outstandingHtml = outstanding
    .map((f) => {
      const assigned = assignedItems[f.id];

      // Waived — resolved locally, no real evidence change.
      if (assigned?.status === "waived") {
        return `
    <div class="assign-row waived">
      <div class="assign-row-top">
        ${badge(NEXT_STEP_BADGE, "waived")}
        <span class="finding-dimension">${escapeHtml(f.dimension)}</span>
        <span class="unchanged-note" style="margin-left:auto;">Waived by ${escapeHtml(assigned.assignee)} — no follow-up needed</span>
        <button class="webhook-btn" onclick="unassignItem('${f.id}')">Reopen</button>
      </div>
    </div>`;
      }

      // Assigned, not yet resolved — offer either a real feedback submission (re-runs the
      // pipeline and can genuinely clear this) or a local waive (just closes the tracker item).
      if (assigned?.status === "assigned") {
        return `
    <div class="assign-row assigned">
      <div class="assign-row-top">
        ${badge(NEXT_STEP_BADGE, f.recommendedNextStepCategory)}
        <span class="finding-dimension">${escapeHtml(f.dimension)}</span>
        <span class="unchanged-note">confidence ${f.confidence}</span>
        <span class="assign-person" style="margin-left:auto;">
          <span class="avatar avatar-sm">${escapeHtml(initials(assigned.assignee))}</span>${escapeHtml(assigned.assignee)}
        </span>
        <button class="webhook-btn" onclick="unassignItem('${f.id}')">Unassign</button>
      </div>
      <div class="assign-form">
        <textarea id="assignee-note-${f.id}" class="note-textarea" rows="2" placeholder="What ${escapeHtml(assigned.assignee)} found — submitting confirms this at confidence 0.95 and re-runs synthesis"></textarea>
        <div class="assign-form-actions">
          <button class="run-btn" onclick="submitAssignFeedback('${f.id}')">Submit feedback &amp; re-run</button>
          <button class="webhook-btn" onclick="waiveItem('${f.id}')">Waive — no follow-up needed</button>
        </div>
      </div>
    </div>`;
      }

      // Unassigned — just pick who owns it.
      const defaultAssignee = defaultAssigneeFor(f.dimension);
      return `
    <div class="assign-row">
      <div class="assign-row-top">
        ${badge(NEXT_STEP_BADGE, f.recommendedNextStepCategory)}
        <span class="finding-dimension">${escapeHtml(f.dimension)}</span>
        <span class="unchanged-note">confidence ${f.confidence}</span>
      </div>
      <div class="assign-person-field">
        <span class="avatar avatar-sm" id="assignee-avatar-${f.id}">${escapeHtml(initials(defaultAssignee))}</span>
        <input class="assign-name-input" list="teamRoster" id="assignee-${f.id}" value="${escapeHtml(defaultAssignee)}" oninput="updateAssigneeAvatar('${f.id}')">
        <button class="webhook-btn" onclick="assignItem('${f.id}')">Assign</button>
      </div>
    </div>`;
    })
    .join("");

  const outstandingSectionHtml =
    outstanding.length > 0
      ? `<h4 style="margin-top:0;">Outstanding follow-up (${stillOpenCount})</h4>
         <datalist id="teamRoster">${TEAM_ROSTER.map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.role)}</option>`).join("")}</datalist>
         <div class="assign-list">${outstandingHtml}</div>`
      : `<p class="unchanged-note">No outstanding follow-up — every finding has resolved to "no further investigation needed."</p>`;

  const feedbackToggleHtml = hasFeedback
    ? `<button class="webhook-btn" onclick="runPipeline('${currentDeal.dealId}', {waiveFeedback: ${feedbackApplied}})">${
        feedbackApplied ? "Re-run without applying feedback fixture" : "Re-run and apply feedback fixture"
      }</button>`
    : "";

  // Still-unconfirmed findings, eligible for a manual feedback entry.
  const eligible = finalPortrait.gapFindings.filter((f) => f.evidenceTier === "inferred_hypothesis");

  const basketHtml = manualEntries
    .map(
      (e, i) => `
    <div class="diff-row">
      <span class="finding-dimension">${escapeHtml(e.dimension)}</span>
      <span class="unchanged-note">${e.clientConfirms ? (e.clientDisputes ? "confirmed (with caveat)" : "confirmed") : "noted"}: "${escapeHtml(e.note)}"</span>
      <button class="webhook-btn" style="margin-left:auto;" onclick="removeManualEntry(${i})">Remove</button>
    </div>`
    )
    .join("");

  const formHtml =
    eligible.length > 0
      ? `
    <div class="claim-callout" style="margin-top:16px;">
      <span class="claim-label">Add manual feedback entry</span>
      <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
        <select id="manualFindingSelect">
          ${eligible.map((f) => `<option value="${f.id}" data-dimension="${escapeHtml(f.dimension)}">${escapeHtml(f.dimension)} — ${escapeHtml(f.statement.slice(0, 60))}...</option>`).join("")}
        </select>
        <div class="feedback-radio-group">
          <label class="feedback-radio"><input type="radio" name="manualConfirm" value="confirm" checked onchange="toggleManualNoteField()"> Client confirms</label>
          <label class="feedback-radio"><input type="radio" name="manualConfirm" value="partial" onchange="toggleManualNoteField()"> Client confirms with a caveat</label>
          <label class="feedback-radio"><input type="radio" name="manualConfirm" value="unconfirmed" onchange="toggleManualNoteField()"> Other remarks</label>
        </div>
        <textarea id="manualNote" class="note-textarea" rows="2" placeholder="What did the client/internal contact actually say?" hidden></textarea>
        <div>
          <button class="webhook-btn" onclick="addManualEntry()">Add entry</button>
          ${manualEntries.length > 0 ? `<button class="run-btn" onclick="submitManualFeedback()" style="margin-left:8px;">Submit ${manualEntries.length} entr${manualEntries.length === 1 ? "y" : "ies"} &amp; re-run synthesis</button>` : ""}
        </div>
      </div>
      ${basketHtml ? `<div style="margin-top:10px;">${basketHtml}</div>` : ""}
    </div>`
      : `<p class="unchanged-note" style="margin-top:16px;">No remaining unconfirmed hypotheses to collect feedback on.</p>`;

  return `
  <section class="stage tab-panel-header-omitted">
    <div class="stage-body">
      ${outstandingSectionHtml}
      <div class="section-heading-row">
        <h4 style="margin:0;">Feedback</h4>
        ${feedbackToggleHtml}
      </div>
      ${
        feedbackApplied
          ? `<p class="unchanged-note" style="margin-bottom:12px;">Collected via ${escapeHtml(feedbackInput?.collectedVia ?? "client feedback")}</p>
             ${diffHtml || '<p class="unchanged-note">Feedback was applied but did not change any finding’s evidence tier.</p>'}`
          : `<p class="waived-note">No feedback applied yet on this run — inferred hypotheses are still unconfirmed. Waived, or add one manually below.</p>`
      }
      ${formHtml}
    </div>
  </section>`;
}

function updateAssigneeAvatar(gapFindingId) {
  const input = document.getElementById(`assignee-${gapFindingId}`);
  const avatar = document.getElementById(`assignee-avatar-${gapFindingId}`);
  if (!input || !avatar) return;
  avatar.textContent = initials(input.value.trim() || "?");
}

function assignItem(gapFindingId) {
  const input = document.getElementById(`assignee-${gapFindingId}`);
  if (!input || !input.value.trim()) return;
  assignedItems[gapFindingId] = { assignee: input.value.trim(), status: "assigned" };
  renderDealView();
}

function unassignItem(gapFindingId) {
  delete assignedItems[gapFindingId];
  renderDealView();
}

function waiveItem(gapFindingId) {
  const current = assignedItems[gapFindingId];
  if (!current) return;
  assignedItems[gapFindingId] = { ...current, status: "waived" };
  renderDealView();
}

/** Submits the assignee's note as REAL feedback for one finding — genuinely re-runs Stage 2/3. */
async function submitAssignFeedback(gapFindingId) {
  const assigned = assignedItems[gapFindingId];
  const note = document.getElementById(`assignee-note-${gapFindingId}`)?.value.trim();
  if (!assigned || !note) return;
  await postFeedback({ [gapFindingId]: { clientConfirms: true, clientDisputes: false, note } }, `assigned follow-up (${assigned.assignee})`);
}

function toggleManualNoteField() {
  const choice = document.querySelector('input[name="manualConfirm"]:checked')?.value;
  const textarea = document.getElementById("manualNote");
  if (!textarea) return;
  textarea.hidden = choice === "confirm";
}

function addManualEntry() {
  const select = document.getElementById("manualFindingSelect");
  if (!select) return;
  const confirmChoice = document.querySelector('input[name="manualConfirm"]:checked').value;
  const typedNote = document.getElementById("manualNote")?.value.trim() ?? "";
  if (confirmChoice !== "confirm" && !typedNote) return; // a caveat or remark needs actual text
  const note = confirmChoice === "confirm" ? "Confirmed, no additional remarks." : typedNote;

  manualEntries.push({
    gapFindingId: select.value,
    dimension: select.selectedOptions[0].dataset.dimension,
    clientConfirms: confirmChoice !== "unconfirmed",
    clientDisputes: confirmChoice === "partial",
    note,
  });
  renderDealView();
}

function removeManualEntry(index) {
  manualEntries.splice(index, 1);
  renderDealView();
}

async function submitManualFeedback() {
  const findings = Object.fromEntries(
    manualEntries.map((e) => [e.gapFindingId, { clientConfirms: e.clientConfirms, clientDisputes: e.clientDisputes, note: e.note }])
  );
  manualEntries = [];
  await postFeedback(findings, "manual entry (UI)");
}

/** Shared POST to the real feedback endpoint — re-runs Stage 2 + Stage 3 against the given findings. */
async function postFeedback(findings, collectedVia) {
  runStatus = "running";
  runStage = "synthesizing"; // this path always skips straight to Stage 2/3, reusing the existing portrait
  renderDealView();

  try {
    const res = await fetch(`/api/deals/${currentDeal.dealId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ findings, collectedVia }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Unknown error");
    startPolling(data.runId);
  } catch (err) {
    runStatus = "error";
    runError = err.message;
    renderDealView();
  }
}

// ---- Stage 3: Synthesis ----

function renderStage3() {
  const pm = runResult.postmortem;
  const portrait = runResult.finalPortrait;

  const renderCause = (c) => {
    const finding = portrait.gapFindings.find((f) => f.id === c.gapFindingId);
    const dept = departmentFor(finding?.dimension);
    return `
      <div class="finding">
        <div class="finding-top">
          <span class="dept-tag">${escapeHtml(dept)}</span>
          <span class="finding-dimension">${c.rank}. ${escapeHtml(finding?.dimension ?? c.gapFindingId)}</span>
          ${badge(TIER_BADGE, finding?.evidenceTier)}
          <span class="finding-score num">score ${c.score}</span>
        </div>
        <p class="finding-statement">${escapeHtml(firstSentence(c.explanation))}</p>
      </div>`;
  };

  const actionsByCategory = new Map();
  for (const a of pm.actions) {
    if (!actionsByCategory.has(a.category)) actionsByCategory.set(a.category, []);
    actionsByCategory.get(a.category).push(a);
  }
  const actionsHtml =
    [...actionsByCategory.entries()]
      .map(
        ([category, actions]) => `
    <div style="margin-bottom:14px;">
      <div class="dept-name" style="margin-bottom:6px;">${escapeHtml(category)}</div>
      ${actions
        .map(
          (a) => `
      <div class="action-item">
        <div>
          <div class="action-desc">${escapeHtml(a.description)}</div>
          <div class="action-source">from: ${a.sourceGapFindingIds.map(escapeHtml).join(", ")}</div>
        </div>
      </div>`
        )
        .join("")}
    </div>`
      )
      .join("") || '<p class="unchanged-note">No actions proposed.</p>';

  const publishHtml = (pm.publishTargets ?? [])
    .map(
      (t) => `
    <div class="dept-insight">
      <span class="dept-name">${t.simulated ? "○" : "✓"} ${escapeHtml(t.target)}</span>
      <span class="${t.simulated ? "unchanged-note" : ""}">${escapeHtml(t.detail)}${t.simulated ? " (simulated)" : ""}</span>
    </div>`
    )
    .join("");

  const speculativeHtml =
    (pm.speculativeHypotheses ?? [])
      .map(
        (h) => `
    <div class="finding">
      <div class="finding-top">
        <span class="finding-dimension">${escapeHtml(h.dimension)}</span>
        ${badge(TIER_BADGE, h.evidenceTier)}
        <span class="finding-score num">confidence ${h.confidence}</span>
      </div>
      <p class="finding-statement">${escapeHtml(h.statement)}</p>
    </div>`
      )
      .join("") || '<p class="unchanged-note">None — every dimension here is either well-documented or not genuinely in question. That\'s a good sign, not a gap.</p>';

  const outstandingCount = Object.entries(pm.nextStepsRollup ?? {})
    .filter(([category]) => category !== "no_further_investigation_needed")
    .reduce((sum, [, items]) => sum + items.length, 0);

  const findingById = new Map(portrait.gapFindings.map((f) => [f.id, f]));
  const rollupHtml = Object.entries(pm.nextStepsRollup ?? {})
    .map(([category, items]) => {
      if (items.length === 0) return "";
      const clickable = category !== "no_further_investigation_needed";
      // Ranked by the same deterministic score as "Ranked causes" — most important item first.
      const ranked = [...items].sort((a, b) => (findingById.get(b.gapFindingId)?.score ?? 0) - (findingById.get(a.gapFindingId)?.score ?? 0));
      const itemsLabel = ranked
        .map((i) => {
          const f = findingById.get(i.gapFindingId);
          return `${escapeHtml(i.dimension)}${f ? ` (${f.confidence})` : ""}`;
        })
        .join(", ");
      return `
      <div class="next-step-bucket ${clickable ? "clickable" : ""}" ${clickable ? `onclick="switchTab('stage2')"` : ""}>
        ${badge(NEXT_STEP_BADGE, category)}
        <div class="next-step-bucket-count">${items.length}</div>
        <div class="next-step-bucket-items">${itemsLabel}</div>
      </div>`;
    })
    .join("");

  const deptHtml = (pm.departmentInsights ?? [])
    .map(
      (d) => `
    <div class="dept-card">
      <div class="dept-card-name">${escapeHtml(d.department)}</div>
      ${renderTruncated(d.insight, { limit: 180, cssClass: "dept-card-insight" })}
    </div>`
    )
    .join("");

  return `
  <section class="stage tab-panel-header-omitted">
    <div class="stage-body">
      <h4>Summary</h4>
      ${renderTruncated(pm.summary, { limit: 260, cssClass: "summary-text" })}

      <div class="section-heading-row">
        <h4 style="margin:0;">Follow-up tracker</h4>
        ${outstandingCount > 0 ? `<button class="webhook-btn" onclick="switchTab('stage2')">${outstandingCount} outstanding — go to Follow-up tab →</button>` : ""}
      </div>
      <div class="next-steps-rollup">${rollupHtml}</div>

      <h4>Ranked causes (top ${Math.min(LIST_CAP, pm.rankedCauses.length)} of ${pm.rankedCauses.length})</h4>
      ${renderCappedList(pm.rankedCauses, renderCause)}

      <h4>Remedial actions</h4>
      ${actionsHtml}

      <h4>By department</h4>
      <div class="dept-grid">${deptHtml || '<p class="unchanged-note">No department insights.</p>'}</div>

      <h4>Speculative hypotheses (not actioned)</h4>
      ${speculativeHtml}

      ${pm.recoveryNote ? `<div class="recovery-note">Recovery note (not a plan — just an aside): ${escapeHtml(pm.recoveryNote)}</div>` : ""}

      <h4>Published to</h4>
      ${publishHtml || '<p class="unchanged-note">Not published anywhere yet.</p>'}
    </div>
  </section>`;
}

loadDeals();
loadStatusStrip();
setInterval(loadStatusStrip, 20000);
