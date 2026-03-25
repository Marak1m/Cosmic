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

let socket;
let activeAgent = null;
let pendingClarifyRunId = null;
let clarifyOverlay = null;
const messageNodesById = new Map();

const presetPrompt = new URLSearchParams(window.location.search).get("prompt");
if (presetPrompt && promptInput) {
  promptInput.value = presetPrompt;
}

function setStatus(text) {
  statusPill.textContent = text;
}

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

function resetUI() {
  agentGrid.innerHTML = "";
  chatFeed.innerHTML = "";
  finalOutput.textContent = "Run a mission to see the leader's finalized response here.";
  runIdLabel.textContent = "Planning...";
  liveStatus.textContent = "Preparing";
  finalStatus.textContent = "Pending";
  activeAgent = null;
  pendingClarifyRunId = null;
  hideClarifications();
  if (promptInput) promptInput.disabled = false;
  messageNodesById.clear();
}

function renderAgents(leader, agents) {
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
}

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

function setActiveAgent(name) {
  if (activeAgent === name) return;
  activeAgent = name;

  document.querySelectorAll(".agent-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.agent === name);
  });
}

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
  finalStatus.textContent = "Awaiting clarifications";

  const firstAnswer = overlay.querySelector(".clarify-answer");
  if (firstAnswer) firstAnswer.focus();
}

function handleEvent(payload) {
  switch (payload.type) {
    case "status":
      setStatus(payload.message);
      liveStatus.textContent = payload.message;
      if (payload.runId) {
        runIdLabel.textContent = `Run: ${payload.runId}`;
      }
      break;
    case "agents":
      renderAgents(payload.leader, payload.agents || []);
      runIdLabel.textContent = `Run: ${payload.runId}`;
      break;
    case "speaker":
      setActiveAgent(payload.name);
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
      if (payload.runId) {
        runIdLabel.textContent = `Run: ${payload.runId}`;
      }
      showClarifications(payload.runId, payload.questions || []);
      break;
    case "final":
      finalOutput.textContent = payload.content;
      finalStatus.textContent = "Complete";
      setStatus("Complete");
      runButton.disabled = false;
      if (promptInput) promptInput.disabled = false;
      break;
    case "error":
      finalOutput.textContent = payload.message;
      finalStatus.textContent = "Error";
      setStatus("Error");
      runButton.disabled = false;
      if (promptInput) promptInput.disabled = false;
      hideClarifications();
      break;
    default:
      break;
  }
}

promptForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setStatus("Connecting...");
    return;
  }

  resetUI();
  runButton.disabled = true;
  setStatus("Launching...");

  socket.send(
    JSON.stringify({
      type: "start",
      prompt,
    })
  );
});

connectSocket();
