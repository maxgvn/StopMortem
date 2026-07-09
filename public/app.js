const dealListEl = document.getElementById("dealList");
const emptyStateEl = document.getElementById("emptyState");
const dealViewEl = document.getElementById("dealView");

let deals = [];
let activeDealId = null;
let runResult = null; // { postmortem, portrait, finalPortrait, feedbackApplied, feedbackInput, location }

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

async function loadDeals() {
  deals = await fetch("/api/deals").then((r) => r.json());
  renderSidebar();
}

function renderSidebar() {
  dealListEl.innerHTML = deals
    .map(
      (d) => `
    <div class="deal-card ${d.dealId === activeDealId ? "active" : ""}" data-deal-id="${d.dealId}">
      <div class="deal-card-name">${escapeHtml(d.dealName)}</div>
      <div class="deal-card-meta">
        <span class="deal-card-amount">${fmtMoney(d.amount)}</span>
        <span>·</span>
        <span>${escapeHtml(d.company)}</span>
      </div>
    </div>`
    )
    .join("");

  dealListEl.querySelectorAll(".deal-card").forEach((card) => {
    card.addEventListener("click", () => selectDeal(card.dataset.dealId));
  });
}

async function selectDeal(dealId) {
  activeDealId = dealId;
  runResult = null;
  renderSidebar();
  emptyStateEl.hidden = true;
  dealViewEl.hidden = false;

  const deal = await fetch(`/api/deals/${dealId}`).then((r) => r.json());
  renderDealView(deal, null);
}

function renderDealView(deal, status) {
  const hasFeedback = deals.find((d) => d.dealId === deal.dealId)?.hasFeedback;

  dealViewEl.innerHTML = `
    <div class="deal-header">
      <h2>${escapeHtml(deal.meta.dealName)}</h2>
      <div class="deal-header-meta">
        <span><strong>${fmtMoney(deal.deal.amount)}</strong></span>
        <span>${escapeHtml(deal.deal.pipelineStagesReached.join(" → "))}</span>
        <span>Stated reason: "${escapeHtml(deal.deal.closedLostReason)}"</span>
      </div>
      <div class="run-controls">
        <button class="run-btn" id="runBtn">Run post-mortem</button>
        <label><input type="checkbox" id="waiveFeedback" ${hasFeedback ? "" : "disabled"}> Waive feedback${hasFeedback ? "" : " (none available)"}</label>
        <span id="runStatus" class="run-status">${status ?? ""}</span>
      </div>
    </div>
    <div id="stages"></div>
  `;

  document.getElementById("runBtn").addEventListener("click", () => runPipeline(deal.dealId));

  if (runResult) renderStages();
}

async function runPipeline(dealId) {
  const runBtn = document.getElementById("runBtn");
  const statusEl = document.getElementById("runStatus");
  runBtn.disabled = true;
  statusEl.className = "run-status";
  statusEl.textContent = "Running — real Claude + Sillage + FullEnrich calls, ~30-90s...";
  document.getElementById("stages").innerHTML = "";

  const waiveFeedback = document.getElementById("waiveFeedback").checked;

  try {
    const res = await fetch(`/api/deals/${dealId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ waiveFeedback }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Unknown error");
    runResult = data;
    statusEl.textContent = `Done — output written to ${data.location}`;
    renderStages();
  } catch (err) {
    statusEl.className = "run-status error";
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    runBtn.disabled = false;
  }
}

function renderStages() {
  const stagesEl = document.getElementById("stages");
  stagesEl.innerHTML = renderStage1() + renderStage2() + renderStage3();
}

// ---- Stage 1: Evidence Portrait ----

function renderStage1() {
  const p = runResult.portrait;

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

  const findingsHtml = p.gapFindings
    .map(
      (f) => `
    <div class="finding">
      <div class="finding-top">
        <span class="finding-dimension">${escapeHtml(f.dimension)}</span>
        ${badge(TIER_BADGE, f.evidenceTier)}
        <span class="finding-score num">score ${f.score}</span>
      </div>
      <p class="finding-statement">${escapeHtml(f.statement)}</p>
      <div class="citations">
        ${f.evidenceCitations
          .map(
            (c) => `<div class="citation"><span class="cite-source">${escapeHtml(c.source)}</span> — ${escapeHtml(c.quote || c.ref)}</div>`
          )
          .join("")}
      </div>
    </div>`
    )
    .join("");

  const toolLogHtml = p.toolCallLog
    .map((t) => `<div class="tool-log-item"><span class="mono">${escapeHtml(t.tool)}</span>(${escapeHtml(t.argsSummary)})</div>`)
    .join("");

  return `
  <section class="stage">
    <div class="stage-header">
      <span class="stage-number">STAGE 1</span>
      <h3 class="stage-title">Evidence Portrait</h3>
      <span class="stage-subtitle">${p.toolCallLog.length} live Sillage/FullEnrich calls</span>
    </div>
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

      <h4>Gap findings (${p.gapFindings.length})</h4>
      ${findingsHtml}

      <details class="tool-log">
        <summary>Tool call log</summary>
        <div class="tool-log-list">${toolLogHtml}</div>
      </details>
    </div>
  </section>`;
}

// ---- Stage 2: Follow-up / Feedback ----

function renderStage2() {
  const { portrait, finalPortrait, feedbackApplied, feedbackInput } = runResult;

  if (!feedbackApplied) {
    return `
    <section class="stage">
      <div class="stage-header">
        <span class="stage-number">STAGE 2</span>
        <h3 class="stage-title">Follow-up</h3>
      </div>
      <div class="stage-body">
        <p class="waived-note">Feedback was waived for this run — inferred hypotheses were passed through unconfirmed to synthesis.</p>
      </div>
    </section>`;
  }

  const before = new Map(portrait.gapFindings.map((f) => [f.id, f]));
  const upgraded = finalPortrait.gapFindings.filter((f) => before.get(f.id)?.evidenceTier !== f.evidenceTier);

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

  return `
  <section class="stage">
    <div class="stage-header">
      <span class="stage-number">STAGE 2</span>
      <h3 class="stage-title">Follow-up</h3>
      <span class="stage-subtitle">collected via ${escapeHtml(feedbackInput?.collectedVia ?? "client feedback")}</span>
    </div>
    <div class="stage-body">
      ${diffHtml || '<p class="unchanged-note">Feedback was applied but did not change any finding’s evidence tier.</p>'}
    </div>
  </section>`;
}

// ---- Stage 3: Synthesis ----

function renderStage3() {
  const pm = runResult.postmortem;
  const portrait = runResult.finalPortrait;

  const causesHtml = pm.rankedCauses
    .map((c) => {
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
    })
    .join("");

  const actionsHtml =
    pm.actions
      .map(
        (a) => `
    <div class="action-item">
      <span class="action-category">${escapeHtml(a.category)}</span>
      <div>
        <div class="action-desc">${escapeHtml(a.description)}</div>
        <div class="action-source">from: ${a.sourceGapFindingIds.map(escapeHtml).join(", ")}</div>
      </div>
    </div>`
      )
      .join("") || '<p class="unchanged-note">No actions proposed.</p>';

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

  return `
  <section class="stage">
    <div class="stage-header">
      <span class="stage-number">STAGE 3</span>
      <h3 class="stage-title">Synthesis</h3>
    </div>
    <div class="stage-body">
      <h4>Summary</h4>
      <p class="summary-text">${escapeHtml(pm.summary)}</p>

      <h4>Ranked causes</h4>
      ${causesHtml}

      <h4>Remedial actions</h4>
      ${actionsHtml}

      <h4>Speculative hypotheses (not actioned)</h4>
      ${speculativeHtml}
    </div>
  </section>`;
}

loadDeals();
