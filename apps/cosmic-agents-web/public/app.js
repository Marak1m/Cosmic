/* =========================================================
   COSMIC AGENTS — /demo client
   -----------------------------------------------------------
   Two UI modes:
     - PRE-LAUNCH: prompt form on top of the cosmic backdrop.
     - MISSION:   body.mission-mode; solar system (driven by
                  createSolarSystem from solar.js) on the left,
                  tabbed telemetry rail on the right.
   Everything else (WS events, message rendering, brief /
   heartbeat / SSA renderers) is unchanged from the previous
   Phase-2 wiring — the server contract is identical.
   ========================================================= */

// ── DOM refs ───────────────────────────────────────────────
const statusPill = document.getElementById("status-pill");
const runIdLabel = document.getElementById("run-id");
const liveStatus = document.getElementById("live-status");
const finalStatus = document.getElementById("final-status");
const agentGrid = document.getElementById("agent-grid");
const chatFeed = document.getElementById("chat-feed");
const finalOutput = document.getElementById("final-output");
const promptForm = document.getElementById("prompt-form");
const promptInput = document.getElementById("prompt-input");
const runButton = document.getElementById("run-btn");
const newMissionBtn = document.getElementById("new-mission-btn");
const missionRail = document.getElementById("mission-rail");
const graphContainer = document.getElementById("agent-graph");
const graphStatusEl = document.getElementById("graph-status");

// Task brief / heartbeat state + refs
const subtaskNodesById = new Map();
const briefSummaryEl = document.getElementById("brief-summary");
const briefConstraintsEl = document.getElementById("brief-constraints");
const briefSubtasksEl = document.getElementById("brief-subtasks");
const briefStatusEl = document.getElementById("brief-status");
const hbCovFill = document.getElementById("hb-coverage-fill");
const hbCovValue = document.getElementById("hb-coverage-value");
const hbConFill = document.getElementById("hb-consistency-fill");
const hbConValue = document.getElementById("hb-consistency-value");
const hbStable = document.getElementById("hb-stable");
const hbStatus = document.getElementById("heartbeat-status");
const hbInconsistencies = document.getElementById("hb-inconsistencies");
const ssaChip = document.getElementById("ssa-chip");

// ── WS + solar state ───────────────────────────────────────
let socket;
let activeAgent = null;
let pendingClarifyRunId = null;
let clarifyOverlay = null;
let solar = null; // solar-system instance from createSolarSystem
const messageNodesById = new Map();

// Presets via ?prompt=
const presetPrompt = new URLSearchParams(window.location.search).get("prompt");
if (presetPrompt && promptInput) {
  promptInput.value = presetPrompt;
}

function setStatus(text) {
  if (statusPill) statusPill.textContent = text;
}

// ── Mission mode ───────────────────────────────────────────
function enterMissionMode() {
  document.body.classList.add("mission-mode");
  // Ensure the solar instance is live when we enter mission mode.
  ensureSolar();
  // Default tab on every fresh launch.
  switchTab("dialogue");
}

function exitMissionMode() {
  document.body.classList.remove("mission-mode");
}

function ensureSolar() {
  if (solar || !graphContainer || typeof window.createSolarSystem !== "function") {
    return solar;
  }
  solar = window.createSolarSystem(graphContainer, {
    mode: "live",
    statusEl: graphStatusEl,
  });
  return solar;
}

// ── Tabs ───────────────────────────────────────────────────
function switchTab(name) {
  if (!missionRail) return;
  missionRail.dataset.tab = name;
  document.querySelectorAll(".mission-tab").forEach((tab) => {
    const isActive = tab.dataset.tab === name;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
    if (isActive) tab.removeAttribute("data-flash");
  });
}

function flashTab(name) {
  const btn = document.querySelector(`.mission-tab[data-tab="${name}"]`);
  if (!btn) return;
  // Don't flash the currently-active tab.
  if (btn.classList.contains("active")) return;
  btn.setAttribute("data-flash", "1");
  setTimeout(() => btn.removeAttribute("data-flash"), 3500);
}

document.querySelectorAll(".mission-tab").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});

// ── WebSocket ──────────────────────────────────────────────
function connectSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${protocol}://${window.location.host}/ws`;
  socket = new WebSocket(wsUrl);

  socket.addEventListener("open", () => {
    setStatus("Connected");
  });

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    handleEvent(payload);
  });

  socket.addEventListener("close", () => {
    setStatus("Disconnected");
    hideClarifications();
    setTimeout(connectSocket, 1500);
  });
}

// ── UI reset ───────────────────────────────────────────────
function resetUI({ keepMissionMode = false } = {}) {
  if (agentGrid) agentGrid.innerHTML = "";
  if (chatFeed) chatFeed.innerHTML = "";
  if (finalOutput) {
    finalOutput.innerHTML =
      '<p class="mono">Run a mission to see the Leader\'s finalized response here.</p>';
  }
  if (runIdLabel) runIdLabel.textContent = "Planning...";
  if (liveStatus) liveStatus.textContent = "Preparing";
  if (finalStatus) finalStatus.textContent = "Pending";
  activeAgent = null;
  pendingClarifyRunId = null;
  hideClarifications();
  if (promptInput) promptInput.disabled = false;
  messageNodesById.clear();

  // Solar
  if (solar) {
    solar.destroy();
    solar = null;
  }
  if (graphStatusEl) graphStatusEl.textContent = "Waiting for crew...";

  // Brief + heartbeat
  subtaskNodesById.clear();
  if (briefSummaryEl) briefSummaryEl.textContent = "";
  if (briefConstraintsEl) briefConstraintsEl.innerHTML = "";
  if (briefSubtasksEl) briefSubtasksEl.innerHTML = "";
  if (briefStatusEl) briefStatusEl.textContent = "No brief yet";
  if (hbCovFill) hbCovFill.style.width = "0%";
  if (hbConFill) hbConFill.style.width = "0%";
  if (hbCovValue) hbCovValue.textContent = "--";
  if (hbConValue) hbConValue.textContent = "--";
  if (hbStable) {
    hbStable.textContent = "pending";
    hbStable.removeAttribute("data-stable");
  }
  if (hbStatus) hbStatus.textContent = "No check-in yet";
  if (hbInconsistencies) hbInconsistencies.innerHTML = "";
  if (ssaChip) {
    ssaChip.setAttribute("data-hidden", "1");
    ssaChip.removeAttribute("data-reason");
    ssaChip.textContent = "SSA · idle";
  }

  if (!keepMissionMode) exitMissionMode();
}

// ── Agent grid ─────────────────────────────────────────────
function renderAgents(leader, agents) {
  if (!agentGrid) return;
  agentGrid.innerHTML = "";

  const buildCard = (name, roleLabel, tools = []) => {
    const card = document.createElement("div");
    card.className = "agent-card";
    card.dataset.agent = name;

    const header = document.createElement("div");
    header.className = "agent-header";

    const title = document.createElement("div");
    title.className = "agent-name";
    title.textContent = name;

    header.appendChild(title);

    if (Array.isArray(tools) && tools.includes("web_search")) {
      const badge = document.createElement("span");
      badge.className = "agent-badge";
      badge.textContent = "web";
      header.appendChild(badge);
    }

    const role = document.createElement("div");
    role.className = "agent-role";
    role.textContent = roleLabel;

    card.appendChild(header);
    card.appendChild(role);
    return card;
  };

  if (leader) {
    agentGrid.appendChild(buildCard(leader.name, "Leader", leader.tools || []));
  }

  agents.forEach((agent) => {
    agentGrid.appendChild(buildCard(agent.name, agent.role, agent.tools || []));
  });

  // Hand the crew off to the solar instance so it can lay out orbits.
  const s = ensureSolar();
  if (s) s.layout(leader, agents);
}

// ── Chat feed ──────────────────────────────────────────────
function ensureMessageNode(id, name) {
  if (id && messageNodesById.has(id)) {
    return messageNodesById.get(id);
  }

  const message = document.createElement("div");
  message.className = "chat-message";

  const sender = document.createElement("div");
  sender.className = "sender";
  sender.textContent = name;

  const body = document.createElement("div");
  body.className = "content";
  body.dataset.placeholder = "0";

  message.appendChild(sender);
  message.appendChild(body);
  chatFeed.appendChild(message);
  chatFeed.scrollTop = chatFeed.scrollHeight;

  const entry = { message, body };
  if (id) messageNodesById.set(id, entry);
  return entry;
}

function setMessageText(id, name, content) {
  const normalizeContent = (sender, value) => {
    let text = "";
    if (typeof value === "string") {
      text = value;
    } else if (value === null || value === undefined) {
      text = "";
    } else {
      try {
        text = JSON.stringify(value, null, 2);
      } catch {
        text = String(value);
      }
    }

    const original = text.replace(/\r\n/g, "\n").trim();
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    while (lines.length) {
      const first = (lines[0] || "").trim();
      if (!first) {
        lines.shift();
        continue;
      }
      if (first === sender || first === `${sender}:`) {
        lines.shift();
        continue;
      }
      break;
    }

    const cleaned = lines.join("\n").trim();
    if (cleaned) return cleaned;
    if (original) return original;
    return "(empty response)";
  };

  const node = ensureMessageNode(id, name);
  node.body.textContent = normalizeContent(name, content);
  node.body.dataset.placeholder = "0";
  chatFeed.scrollTop = chatFeed.scrollHeight;
}

// ── Speaker switching ──────────────────────────────────────
function setActiveAgent(name) {
  if (activeAgent === name) return;

  const s = ensureSolar();
  if (s) s.setSpeaker(name);
  activeAgent = name;

  document.querySelectorAll(".agent-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.agent === name);
  });
}

// ── Clarifications overlay ─────────────────────────────────
function buildClarificationAnswerText(root) {
  const answers = [];
  (root || document).querySelectorAll(".clarify-answer").forEach((node, index) => {
    const q = node.dataset.question || `Q${index + 1}`;
    const a = (node.value || "").trim();
    answers.push(`Q: ${q}\nA: ${a || "(no answer)"}`);
  });
  return answers.join("\n\n").trim();
}

function hideClarifications() {
  pendingClarifyRunId = null;
  if (clarifyOverlay) {
    clarifyOverlay.remove();
    clarifyOverlay = null;
  }
}

function showClarifications(runId, questions) {
  hideClarifications();
  pendingClarifyRunId = runId;

  const overlay = document.createElement("div");
  overlay.className = "clarify-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const modal = document.createElement("div");
  modal.className = "clarify-modal";

  const title = document.createElement("h2");
  title.textContent = "Quick clarifications";

  const subtitle = document.createElement("p");
  subtitle.className = "clarify-subtitle mono";
  subtitle.textContent =
    "Answering these helps the crew converge faster and avoids wrong assumptions. You can skip if you prefer.";

  const form = document.createElement("form");
  form.className = "clarify-form";

  const questionsWrap = document.createElement("div");
  questionsWrap.className = "clarify-questions";

  const list = Array.isArray(questions) ? questions : [];
  list.forEach((question, index) => {
    const wrapper = document.createElement("div");
    wrapper.className = "clarify-question";

    const label = document.createElement("label");
    label.className = "mono";
    label.textContent = `Q${index + 1}. ${question}`;

    const textarea = document.createElement("textarea");
    textarea.className = "clarify-answer";
    textarea.rows = 3;
    textarea.placeholder = "Your answer...";
    textarea.dataset.question = question;

    wrapper.appendChild(label);
    wrapper.appendChild(textarea);
    questionsWrap.appendChild(wrapper);
  });

  const actions = document.createElement("div");
  actions.className = "clarify-actions";

  const continueButton = document.createElement("button");
  continueButton.type = "submit";
  continueButton.className = "btn primary small";
  continueButton.textContent = "Continue";

  const skipButton = document.createElement("button");
  skipButton.type = "button";
  skipButton.className = "btn secondary small";
  skipButton.textContent = "Skip";

  actions.appendChild(continueButton);
  actions.appendChild(skipButton);

  form.appendChild(questionsWrap);
  form.appendChild(actions);

  modal.appendChild(title);
  modal.appendChild(subtitle);
  modal.appendChild(form);
  overlay.appendChild(modal);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!pendingClarifyRunId) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    const answers = buildClarificationAnswerText(overlay);
    setStatus("Sending clarifications...");
    hideClarifications();

    socket.send(
      JSON.stringify({
        type: "clarify_response",
        runId: pendingClarifyRunId,
        answers,
      })
    );
  });

  skipButton.addEventListener("click", () => {
    if (!pendingClarifyRunId) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    setStatus("Skipping clarifications...");
    hideClarifications();

    socket.send(
      JSON.stringify({
        type: "clarify_response",
        runId: pendingClarifyRunId,
        answers: "",
      })
    );
  });

  document.body.appendChild(overlay);
  clarifyOverlay = overlay;

  if (promptInput) promptInput.disabled = true;
  if (finalStatus) finalStatus.textContent = "Awaiting clarifications";

  const firstAnswer = overlay.querySelector(".clarify-answer");
  if (firstAnswer) firstAnswer.focus();
}

// ── Server event dispatch ──────────────────────────────────
function handleEvent(payload) {
  switch (payload.type) {
    case "status":
      setStatus(payload.message);
      if (liveStatus) liveStatus.textContent = payload.message;
      if (payload.runId && runIdLabel) {
        runIdLabel.textContent = `Run: ${payload.runId}`;
      }
      break;
    case "agents":
      renderAgents(payload.leader, payload.agents || []);
      if (runIdLabel) runIdLabel.textContent = `Run: ${payload.runId}`;
      break;
    case "speaker":
      setActiveAgent(payload.name);
      break;
    case "ssa_decision":
      renderSsaDecision(payload);
      break;
    case "task_brief":
      renderTaskBrief(payload.brief || {});
      break;
    case "subtask_update":
      applySubtaskStatuses(payload.statuses || {});
      break;
    case "heartbeat":
      renderHeartbeat(payload);
      break;
    case "message_start":
      {
        const node = ensureMessageNode(payload.id, payload.name);
        node.body.textContent = "…";
        node.body.dataset.placeholder = "1";
      }
      break;
    case "message_delta": {
      const node = ensureMessageNode(payload.id, payload.name);
      if (node.body.dataset.placeholder === "1") {
        node.body.textContent = "";
        node.body.dataset.placeholder = "0";
      }
      node.body.textContent = `${node.body.textContent || ""}${payload.delta || ""}`;
      chatFeed.scrollTop = chatFeed.scrollHeight;
      break;
    }
    case "message":
      setMessageText(payload.id, payload.name, payload.content);
      break;
    case "clarify":
      if (payload.runId && runIdLabel) {
        runIdLabel.textContent = `Run: ${payload.runId}`;
      }
      showClarifications(payload.runId, payload.questions || []);
      break;
    case "final":
      if (finalOutput) finalOutput.textContent = payload.content;
      if (finalStatus) finalStatus.textContent = "Complete";
      setStatus("Complete");
      if (runButton) runButton.disabled = false;
      if (promptInput) promptInput.disabled = false;
      // Auto-focus Final Output on completion.
      switchTab("final");
      break;
    case "error":
      if (finalOutput) finalOutput.textContent = payload.message;
      if (finalStatus) finalStatus.textContent = "Error";
      setStatus("Error");
      if (runButton) runButton.disabled = false;
      if (promptInput) promptInput.disabled = false;
      hideClarifications();
      break;
    default:
      break;
  }
}

// ── Form submit / New mission ──────────────────────────────
if (promptForm) {
  promptForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const prompt = promptInput.value.trim();
    if (!prompt) return;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setStatus("Connecting...");
      return;
    }

    resetUI({ keepMissionMode: true });
    enterMissionMode();
    if (runButton) runButton.disabled = true;
    setStatus("Launching...");

    socket.send(
      JSON.stringify({
        type: "start",
        prompt,
      })
    );
  });
}

if (newMissionBtn) {
  newMissionBtn.addEventListener("click", () => {
    resetUI();
    setStatus("Idle");
    if (promptInput) {
      promptInput.value = "";
      promptInput.focus();
    }
    if (runButton) runButton.disabled = false;
  });
}

// ── Task brief / heartbeat renderers ───────────────────────
function renderTaskBrief(brief) {
  if (!brief) return;
  if (briefSummaryEl) {
    briefSummaryEl.textContent = brief.task_summary || "";
  }

  if (briefConstraintsEl) {
    briefConstraintsEl.innerHTML = "";
    (brief.constraints || []).forEach((c) => {
      const li = document.createElement("li");
      li.textContent = c;
      briefConstraintsEl.appendChild(li);
    });
    if (!brief.constraints || !brief.constraints.length) {
      const li = document.createElement("li");
      li.textContent = "No hard constraints declared.";
      li.style.color = "var(--dim)";
      briefConstraintsEl.appendChild(li);
    }
  }

  if (briefSubtasksEl) {
    briefSubtasksEl.innerHTML = "";
    subtaskNodesById.clear();
    (brief.subtasks || []).forEach((sub) => {
      const li = document.createElement("li");
      li.dataset.subtaskId = sub.id;
      li.dataset.status = "pending";

      const status = document.createElement("div");
      status.className = "subtask-status";

      const body = document.createElement("div");
      body.className = "subtask-body";

      const top = document.createElement("div");
      top.className = "subtask-top";

      const sid = document.createElement("span");
      sid.className = "subtask-id";
      sid.textContent = sub.id;

      const assignee = document.createElement("span");
      assignee.className = "subtask-assignee";
      assignee.textContent = `→ ${sub.assignee}`;

      top.appendChild(sid);
      top.appendChild(assignee);

      const desc = document.createElement("div");
      desc.className = "subtask-desc";
      desc.textContent = sub.description;

      body.appendChild(top);
      body.appendChild(desc);
      li.appendChild(status);
      li.appendChild(body);
      briefSubtasksEl.appendChild(li);
      subtaskNodesById.set(sub.id, li);
    });
  }

  if (briefStatusEl) {
    const n = (brief.subtasks || []).length;
    briefStatusEl.textContent = `${n} subtasks · 0 complete`;
  }

  flashTab("brief");
}

function applySubtaskStatuses(statuses) {
  if (!statuses || typeof statuses !== "object") return;
  let completed = 0;
  let total = 0;
  subtaskNodesById.forEach((node, id) => {
    total += 1;
    const status = statuses[id] || node.dataset.status || "pending";
    node.dataset.status = status;
    if (status === "complete") completed += 1;
  });
  if (briefStatusEl && total) {
    briefStatusEl.textContent = `${total} subtasks · ${completed} complete`;
  }
}

function renderHeartbeat(payload) {
  const scores = payload.scores || {};
  const coverage = Math.max(0, Math.min(1, Number(scores.coverage) || 0));
  const consistency = Math.max(0, Math.min(1, Number(scores.consistency) || 0));

  if (hbCovFill) hbCovFill.style.width = (coverage * 100).toFixed(0) + "%";
  if (hbConFill) hbConFill.style.width = (consistency * 100).toFixed(0) + "%";
  if (hbCovValue) hbCovValue.textContent = (coverage * 100).toFixed(0) + "%";
  if (hbConValue) hbConValue.textContent = (consistency * 10).toFixed(1) + " / 10";
  if (hbStable) {
    hbStable.textContent = scores.stable ? "stable" : "settling";
    hbStable.dataset.stable = scores.stable ? "yes" : "no";
  }
  if (hbStatus) {
    const when = typeof payload.turn === "number" ? ` (turn ${payload.turn + 1})` : "";
    hbStatus.textContent = `Last check-in${when}${payload.readyFlag ? " · ready" : ""}`;
  }
  if (hbInconsistencies) {
    hbInconsistencies.innerHTML = "";
    (payload.inconsistencies || []).forEach((msg) => {
      const li = document.createElement("li");
      li.textContent = msg;
      hbInconsistencies.appendChild(li);
    });
  }
  if (payload.statuses) {
    applySubtaskStatuses(payload.statuses);
  }

  // Flash the Heartbeat tab when consistency dips below θ_H so the
  // user notices the Leader raising concerns even while reading
  // the dialogue.
  if (consistency < 0.8 || (payload.inconsistencies || []).length > 0) {
    flashTab("heartbeat");
  }
}

function renderSsaDecision(payload) {
  if (!ssaChip) return;
  const reason = String(payload.reason || "").toLowerCase();
  const label = reason.replace(/_/g, " ");
  ssaChip.textContent = `SSA · ${label || "select"} → ${payload.chosen || "?"}`;
  ssaChip.dataset.reason = reason;
  ssaChip.removeAttribute("data-hidden");
}

// ── Boot ───────────────────────────────────────────────────
connectSocket();
