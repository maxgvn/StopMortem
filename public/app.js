const dealListEl = document.getElementById("dealList");
const emptyStateEl = document.getElementById("emptyState");
const dealViewEl = document.getElementById("dealView");
const statusStripEl = document.getElementById("statusStrip");

let deals = [];
let activeDealId = null;
let currentDeal = null;
let runResult = null; // { postmortem, portrait, finalPortrait, feedbackApplied, feedbackInput, location }
let runStatus = "idle"; // idle | running | completed | error
let runError = null;
let activeTab = "stage1";
let pollHandle = null;
let manualEntries = []; // [{ gapFindingId, dimension, clientConfirms, clientDisputes, note }] — staged, not yet submitted

const LIST_CAP = 5;

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
};

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
      return `
    <div class="deal-card ${d.dealId === activeDealId ? "active" : ""}" data-deal-id="${d.dealId}">
      <div class="deal-card-name">${escapeHtml(d.dealName)}</div>
      <div class="deal-card-meta">
        <span class="deal-card-amount">${fmtMoney(d.amount)}</span>
        <span>·</span>
        <span>${escapeHtml(d.company)}</span>
        ${running ? `<span class="running-dot"></span><span class="deal-card-running-label">Running</span>` : ""}
      </div>
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
  activeTab = "stage1";
  renderSidebar();
  emptyStateEl.hidden = true;
  dealViewEl.hidden = false;

  currentDeal = await fetch(`/api/deals/${dealId}`).then((r) => r.json());

  // Resume an in-progress or already-completed run for this deal, if one exists —
  // this is what makes navigating away and back not "lose" a run.
  const latest = await fetch(`/api/deals/${dealId}/latest-run`).then((r) => r.json());
  if (latest) {
    if (latest.status === "running") {
      runStatus = "running";
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

async function runPipeline(dealId, { simulateWebhook = false } = {}) {
  const waiveFeedback = document.getElementById("waiveFeedback")?.checked ?? false;
  runStatus = "running";
  runError = null;
  runResult = null;
  renderDealView();

  try {
    const path = simulateWebhook ? "/api/webhooks/deal-closed" : `/api/deals/${dealId}/run`;
    const body = simulateWebhook ? { dealId } : { waiveFeedback };
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
      if (run.status === "running") return; // keep polling, nothing to update yet
      stopPolling();
      runStatus = run.status;
      if (run.status === "completed") runResult = run.result;
      if (run.status === "error") runError = run.error;
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
// (e.g. one triggered via the "simulate CRM webhook" button while looking at a different deal).
setInterval(() => {
  if (!activeDealId) loadDeals();
}, 4000);

// ---- Main deal view ----

function renderDealView() {
  const hasFeedback = deals.find((d) => d.dealId === currentDeal.dealId)?.hasFeedback;
  const isPharma = currentDeal.meta.industry === "life_sciences_pharma";

  const bannerHtml =
    runStatus === "running"
      ? `<div class="running-banner"><span class="spinner"></span>Running — real Claude + Sillage + FullEnrich calls, ~30-90s. This keeps running even if you navigate away.</div>`
      : runStatus === "error"
      ? `<div class="running-banner" style="color:var(--status-critical); border-color:var(--status-critical);">Error: ${escapeHtml(runError)}</div>`
      : "";

  dealViewEl.innerHTML = `
    <div class="deal-header">
      <h2>${escapeHtml(currentDeal.meta.dealName)}</h2>
      <div class="deal-header-meta">
        <span><strong>${fmtMoney(currentDeal.deal.amount)}</strong></span>
        <span>${escapeHtml(currentDeal.deal.pipelineStagesReached.join(" → "))}</span>
        <span>Stated reason: "${escapeHtml(currentDeal.deal.closedLostReason)}"</span>
        ${isPharma ? `<span class="badge" style="background:var(--addon-accent-bg); color:var(--addon-accent);">Pharma/Life Sciences</span>` : ""}
      </div>
      <div class="run-controls">
        <button class="run-btn" id="runBtn" ${runStatus === "running" ? "disabled" : ""}>Run post-mortem</button>
        <button class="webhook-btn" id="webhookBtn" ${runStatus === "running" ? "disabled" : ""} title="Simulates a HubSpot 'Closed Lost' workflow auto-triggering this pipeline — no manual click needed in a real integration">Simulate CRM auto-trigger</button>
        <label><input type="checkbox" id="waiveFeedback" ${hasFeedback ? "" : "disabled"}> Waive feedback${hasFeedback ? "" : " (none available)"}</label>
      </div>
      ${bannerHtml}
    </div>
    ${runResult ? renderTabs() : ""}
  `;

  document.getElementById("runBtn").addEventListener("click", () => runPipeline(currentDeal.dealId));
  document.getElementById("webhookBtn").addEventListener("click", () => runPipeline(currentDeal.dealId, { simulateWebhook: true }));
  attachTabListeners();
}

// ---- Tabs ----

function renderTabs() {
  const { portrait, finalPortrait, feedbackApplied } = runResult;
  const tabs = [
    { id: "stage1", label: "1. Evidence Portrait", count: portrait.gapFindings.length },
    { id: "stage2", label: "2. Follow-up", count: feedbackApplied ? "✓" : "–" },
    { id: "stage3", label: "3. Synthesis", count: finalPortrait.gapFindings.filter((f) => f.evidenceTier !== "inferred_hypothesis").length },
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
  if (activeTab === "stage1") return renderStage1();
  if (activeTab === "stage2") return renderStage2();
  return renderStage3();
}

// ---- Stage 1: Evidence Portrait ----

function renderStage1() {
  const p = runResult.portrait;
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
        <label><input type="radio" name="manualConfirm" value="confirm" checked> Client confirms</label>
        <label><input type="radio" name="manualConfirm" value="partial"> Client confirms with a caveat</label>
        <label><input type="radio" name="manualConfirm" value="unconfirmed"> Just a note (don't upgrade tier)</label>
        <textarea id="manualNote" rows="2" placeholder="What did the client/internal contact actually say?" style="font-family:inherit; font-size:13px; padding:6px;"></textarea>
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

function addManualEntry() {
  const select = document.getElementById("manualFindingSelect");
  const note = document.getElementById("manualNote").value.trim();
  const confirmChoice = document.querySelector('input[name="manualConfirm"]:checked').value;
  if (!select || !note) return;

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
  runStatus = "running";
  renderDealView();

  try {
    const res = await fetch(`/api/deals/${currentDeal.dealId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ findings, collectedVia: "manual entry (UI)" }),
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
    return `
      <div class="finding">
        <div class="finding-top">
          <span class="finding-dimension">${c.rank}. ${escapeHtml(finding?.dimension ?? c.gapFindingId)}</span>
          ${badge(TIER_BADGE, finding?.evidenceTier)}
          ${badge(NEXT_STEP_BADGE, finding?.recommendedNextStepCategory)}
          <span class="finding-score num">score ${c.score}</span>
        </div>
        <p class="finding-statement">${escapeHtml(c.explanation)}</p>
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
      .join("") || '<p class="unchanged-note">No speculative hypotheses.</p>';

  const rollupHtml = Object.entries(pm.nextStepsRollup ?? {})
    .map(([category, items]) => {
      if (items.length === 0) return "";
      const spec = NEXT_STEP_BADGE[category];
      return `
      <div class="next-step-bucket">
        ${badge(NEXT_STEP_BADGE, category)}
        <div class="next-step-bucket-count">${items.length}</div>
        <div class="next-step-bucket-items">${items.map((i) => escapeHtml(i.dimension)).join(", ")}</div>
      </div>`;
    })
    .join("");

  const deptHtml = (pm.departmentInsights ?? [])
    .map((d) => `<div class="dept-insight"><span class="dept-name">${escapeHtml(d.department)}</span><span>${escapeHtml(d.insight)}</span></div>`)
    .join("");

  return `
  <section class="stage tab-panel-header-omitted">
    <div class="stage-body">
      <h4>Summary</h4>
      <p class="summary-text">${escapeHtml(pm.summary)}</p>

      <h4>What happens next</h4>
      <div class="next-steps-rollup">${rollupHtml}</div>

      <h4>Ranked causes (top ${Math.min(LIST_CAP, pm.rankedCauses.length)} of ${pm.rankedCauses.length})</h4>
      ${renderCappedList(pm.rankedCauses, renderCause)}

      <h4>Remedial actions</h4>
      ${actionsHtml}

      <h4>By department</h4>
      ${deptHtml || '<p class="unchanged-note">No department insights.</p>'}

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
