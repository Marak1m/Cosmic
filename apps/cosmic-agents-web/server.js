const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { WebSocketServer } = require("ws");

require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });

let fetchFn = globalThis.fetch;
if (!fetchFn) {
  const nodeFetch = require("node-fetch");
  fetchFn = nodeFetch.default || nodeFetch;
}

const PORT = process.env.PORT || 3000;
function normalizeApiKey(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^"+|"+$/g, "");
}

function normalizeBoolean(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "y";
}

function readIntEnv(name, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const rounded = Math.floor(parsed);
  return Math.min(Math.max(rounded, min), max);
}

const modelTokenParamPreference = new Map();
const modelTemperatureSupported = new Map();
const modelInputCharBudgetScale = new Map();
const modelToolForceSupported = new Map();

const OPENAI_API_KEY = normalizeApiKey(process.env.OPENAI_API_KEY);
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const PLANNER_MODEL = process.env.PLANNER_MODEL || "gpt-4.1";
const LEADER_MODEL = process.env.LEADER_MODEL || "o1";
// Fast, cheap model for the speaker-selection loop. Algorithm 1's
// nomination fast-path already short-circuits ~50% of turns without
// a model call; o1 on the remaining turns added 10-30s of wall-clock
// latency per step. gpt-4o-mini gets us sub-2s selection without
// materially changing which agent is chosen. Override with env if
// you want to A/B against o1 / gpt-5-family.
const SELECTOR_MODEL = process.env.SELECTOR_MODEL || "gpt-4o-mini";
const FINALIZER_MODEL = process.env.FINALIZER_MODEL || "o1";
const ENABLE_PROMPT_OPTIMIZER = normalizeBoolean(process.env.ENABLE_PROMPT_OPTIMIZER);
const OPTIMIZER_MODEL = process.env.OPTIMIZER_MODEL || OPENAI_MODEL;
const ENABLE_USER_CLARIFICATIONS = normalizeBoolean(process.env.ENABLE_USER_CLARIFICATIONS);
const CLARIFIER_MODEL = process.env.CLARIFIER_MODEL || OPTIMIZER_MODEL;
const MAX_CLARIFICATION_QUESTIONS = Math.min(
  Math.max(Number(process.env.MAX_CLARIFICATION_QUESTIONS || 5), 0),
  8
);
const SERPER_API_KEY = normalizeApiKey(process.env.SERPER_API_KEY);
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const ENABLE_STREAMING = normalizeBoolean(process.env.ENABLE_STREAMING ?? "true");
const SEARCH_CACHE_TTL_MS = readIntEnv("SEARCH_CACHE_TTL_MS", 10 * 60 * 1000, { min: 0, max: 24 * 60 * 60 * 1000 });
const SEARCH_CACHE_MAX_ENTRIES = readIntEnv("SEARCH_CACHE_MAX_ENTRIES", 200, { min: 0, max: 2000 });
const SEARCH_BATCH_MAX_QUERIES = readIntEnv("SEARCH_BATCH_MAX_QUERIES", 3, { min: 1, max: 6 });

const MAX_AGENTS = 5;
const MAX_TURNS = readIntEnv("MAX_TURNS", 50, { min: 6, max: 200 });
const LEADER_NAME = "Leader";

// COSMIC coordination hyperparameters (see COSMIC paper §III)
const COSMIC_N = readIntEnv("COSMIC_MEMORY_N", 10, { min: 4, max: 40 });              // rolling window size N
const COSMIC_T_LEADER = readIntEnv("LEADER_CHECKIN_INTERVAL", 7, { min: 3, max: 20 }); // T_leader heartbeat
const COSMIC_THETA_H = Number(process.env.COSMIC_THETA_H || 0.8);                      // consistency threshold
const COSMIC_EPS_C = Number(process.env.COSMIC_EPS_C || 0.1);                          // coverage stability eps
const COSMIC_EPS_H = Number(process.env.COSMIC_EPS_H || 0.1);                          // consistency stability eps
// Kept for backwards compatibility with legacy env (not used by the COSMIC core):
const MEMORY_WINDOW = COSMIC_N;

const MAX_INPUT_TOKENS = readIntEnv("MAX_INPUT_TOKENS", 25000, { min: 1000, max: 100000 });
const MAX_OUTPUT_TOKENS = readIntEnv("MAX_OUTPUT_TOKENS", 25000, { min: 256, max: 25000 });
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_INPUT_CHARS = MAX_INPUT_TOKENS * APPROX_CHARS_PER_TOKEN;
const MAX_TOOL_RESULT_CHARS = Math.floor(MAX_INPUT_CHARS * 0.6);

const PLANNER_MAX_OUTPUT_TOKENS = readIntEnv(
  "PLANNER_MAX_OUTPUT_TOKENS",
  Math.min(2000, MAX_OUTPUT_TOKENS),
  { min: 256, max: MAX_OUTPUT_TOKENS }
);
const LEADER_MAX_OUTPUT_TOKENS = readIntEnv(
  "LEADER_MAX_OUTPUT_TOKENS",
  Math.min(2500, MAX_OUTPUT_TOKENS),
  { min: 256, max: MAX_OUTPUT_TOKENS }
);
const AGENT_MAX_OUTPUT_TOKENS = readIntEnv(
  "AGENT_MAX_OUTPUT_TOKENS",
  Math.min(3000, MAX_OUTPUT_TOKENS),
  { min: 256, max: MAX_OUTPUT_TOKENS }
);
const FINALIZER_MAX_OUTPUT_TOKENS = readIntEnv(
  "FINALIZER_MAX_OUTPUT_TOKENS",
  Math.min(5000, MAX_OUTPUT_TOKENS),
  { min: 256, max: MAX_OUTPUT_TOKENS }
);
const TOOL_CALL_MAX_TOKENS = readIntEnv(
  "TOOL_CALL_MAX_TOKENS",
  Math.min(2500, MAX_OUTPUT_TOKENS),
  { min: 256, max: MAX_OUTPUT_TOKENS }
);
const SELECTOR_MAX_OUTPUT_TOKENS_DEFAULT = readIntEnv(
  "SELECTOR_MAX_OUTPUT_TOKENS",
  Math.min(200, MAX_OUTPUT_TOKENS),
  { min: 64, max: MAX_OUTPUT_TOKENS }
);
const SELECTOR_MAX_OUTPUT_TOKENS_O1 = readIntEnv(
  "SELECTOR_MAX_OUTPUT_TOKENS_O1",
  Math.min(200, MAX_OUTPUT_TOKENS),
  { min: 64, max: MAX_OUTPUT_TOKENS }
);

const AGENT_NAME_POOL = [
  "Agent_A",
  "Agent_B",
  "Agent_C",
  "Agent_D",
  "Agent_E",
];

function isO1Model(value) {
  return /^o1($|-)/i.test(String(value || "").trim());
}

function isGpt5FamilyModel(value) {
  return /^gpt-5([-.]|$)/i.test(String(value || "").trim());
}

function estimateMessageChars(message) {
  if (!message) return 0;
  const role = typeof message.role === "string" ? message.role : "";
  const name = typeof message.name === "string" ? message.name : "";
  const content = typeof message.content === "string" ? message.content : "";
  return role.length + name.length + content.length + 12;
}

function clampText(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  if (maxChars <= 32) return text.slice(0, maxChars);

  const head = Math.max(Math.floor(maxChars * 0.7), 1);
  const marker = "\n...[truncated]...\n";
  const tailBudget = Math.max(maxChars - head - marker.length, 0);
  const tail = tailBudget ? text.slice(-tailBudget) : "";
  return `${text.slice(0, head)}${marker}${tail}`;
}

function trimMessagesToMaxChars(messages, maxChars) {
  if (!Array.isArray(messages) || messages.length <= 1) return messages;

  const systemMessages = messages.filter((m) => m?.role === "system");
  const pinned = systemMessages.length ? systemMessages : [messages[0]];
  const others = systemMessages.length
    ? messages.filter((m) => m?.role !== "system")
    : messages.slice(1);

  let total = 0;
  for (const msg of pinned) total += estimateMessageChars(msg);
  for (const msg of others) total += estimateMessageChars(msg);

  if (total <= maxChars) return [...pinned, ...others];

  const kept = [...others];
  while (kept.length > 1 && total > maxChars) {
    const removed = kept.shift();
    total -= estimateMessageChars(removed);
  }

  if (kept.length && total > maxChars) {
    const pinnedSize = pinned.reduce((sum, msg) => sum + estimateMessageChars(msg), 0);
    const budget = Math.max(maxChars - pinnedSize, 0);
    const target = kept[0];
    const role = typeof target.role === "string" ? target.role : "";
    const name = typeof target.name === "string" ? target.name : "";
    const overhead = role.length + name.length + 12;
    const contentBudget = Math.max(budget - overhead, 0);
    kept[0] = { ...target, content: clampText(target.content, contentBudget) };
  }

  return [...pinned, ...kept];
}

if (!OPENAI_API_KEY || OPENAI_API_KEY.length < 20) {
  console.warn(
    "OPENAI_API_KEY is missing or unusually short. Check your .env file."
  );
} else {
  console.log(
    `OPENAI_API_KEY loaded (length ${OPENAI_API_KEY.length}, last4 ${OPENAI_API_KEY.slice(-4)})`
  );
}

if (!SERPER_API_KEY || SERPER_API_KEY.length < 10) {
  console.log("SERPER_API_KEY not configured; web_search tool is disabled.");
} else {
  console.log(
    `SERPER_API_KEY loaded (length ${SERPER_API_KEY.length}, last4 ${SERPER_API_KEY.slice(-4)})`
  );
}

console.log(
  `Models: OPENAI_MODEL=${OPENAI_MODEL} | PLANNER_MODEL=${PLANNER_MODEL} | OPTIMIZER_MODEL=${OPTIMIZER_MODEL} (enabled=${ENABLE_PROMPT_OPTIMIZER}) | CLARIFIER_MODEL=${CLARIFIER_MODEL} (enabled=${ENABLE_USER_CLARIFICATIONS}, max_q=${MAX_CLARIFICATION_QUESTIONS}) | LEADER_MODEL=${LEADER_MODEL} | SELECTOR_MODEL=${SELECTOR_MODEL} | FINALIZER_MODEL=${FINALIZER_MODEL} | MAX_TURNS=${MAX_TURNS} | MEMORY_WINDOW=${MEMORY_WINDOW}`
);

// (Task templates removed; crew is planned dynamically per prompt.)
const ALLOWED_TOOLS = ["web_search"];

const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web for relevant, up-to-date information.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
      },
      required: ["query"],
    },
  },
};

async function searchWeb(query) {
  if (!SERPER_API_KEY) {
    throw new Error("SERPER_API_KEY is not configured.");
  }

  const normalizeQuery = (value) =>
    String(value || "")
      .replace(/\uFEFF/g, "")
      .trim()
      .replace(/\s+/g, " ");

  const searchCache = searchWeb.cache || (searchWeb.cache = new Map());
  const now = Date.now();

  const pruneCache = () => {
    if (SEARCH_CACHE_TTL_MS <= 0 || SEARCH_CACHE_MAX_ENTRIES <= 0) {
      searchCache.clear();
      return;
    }
    for (const [key, entry] of searchCache.entries()) {
      if (now - entry.timestamp > SEARCH_CACHE_TTL_MS) {
        searchCache.delete(key);
      }
    }
    if (searchCache.size <= SEARCH_CACHE_MAX_ENTRIES) return;
    const keys = Array.from(searchCache.keys());
    for (let i = 0; i < keys.length && searchCache.size > SEARCH_CACHE_MAX_ENTRIES; i += 1) {
      searchCache.delete(keys[i]);
    }
  };

  pruneCache();

  const raw = normalizeQuery(query);
  if (!raw) {
    return JSON.stringify({ query: raw, results: [] });
  }

  const split = raw
    .split(/\n|;|\|/g)
    .map((q) => normalizeQuery(q))
    .filter(Boolean);
  const batch = split.length > 1 ? split.slice(0, SEARCH_BATCH_MAX_QUERIES) : [raw];

  const runSingle = async (q) => {
    const key = q.toLowerCase();
    if (SEARCH_CACHE_TTL_MS > 0) {
      const hit = searchCache.get(key);
      if (hit && now - hit.timestamp <= SEARCH_CACHE_TTL_MS) {
        return hit.value;
      }
    }

    const response = await fetchFn("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q, num: 5 }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Serper API error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const organic = Array.isArray(data.organic) ? data.organic : [];
    const results = organic.slice(0, 5).map((item) => ({
      title: item.title,
      link: item.link,
      snippet: item.snippet,
      date: item.date,
    }));

    const value = JSON.stringify({ query: q, results });
    if (SEARCH_CACHE_TTL_MS > 0 && SEARCH_CACHE_MAX_ENTRIES > 0) {
      searchCache.set(key, { timestamp: now, value });
      pruneCache();
    }
    return value;
  };

  if (batch.length === 1) {
    return runSingle(batch[0]);
  }

  const results = await Promise.all(batch.map((q) => runSingle(q)));
  return results
    .map((value, index) => `Result set ${index + 1}:\n${value}`)
    .join("\n\n");
}

const TOOL_MAP = {
  web_search: searchWeb,
};

function sanitizeTools(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools.filter((tool) => ALLOWED_TOOLS.includes(tool));
}

function normalizeAgentName(name, fallback) {
  const cleaned = String(name || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w]/g, "");
  return cleaned || fallback;
}

function humanizeAgentLabel(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGeneralistRole(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .trim();
  return normalized === "generalist" || normalized === "generalistagent";
}

function isGenericRoleLabel(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .trim();
  return (
    normalized === "planner" ||
    normalized === "constraintchecker" ||
    normalized === "constraintschecker" ||
    normalized === "synthesizer" ||
    isGeneralistRole(normalized)
  );
}

function ensurePromptLines(prompt, requiredLines) {
  let result = String(prompt || "").trim();
  for (const line of requiredLines) {
    if (!line) {
      continue;
    }
    const normalized = line.toLowerCase();
    if (!result.toLowerCase().includes(normalized)) {
      result = result ? `${result}\n${line}` : line;
    }
  }
  return result;
}

const WEB_SEARCH_TRIGGERS = [
  "research",
  "latest",
  "news",
  "sources",
  "citations",
  "references",
  "paper",
  "study",
  "survey",
  "compare",
  "pricing",
  "price",
  "cost",
  "itinerary",
  "itiniary",
  "itenary",
  "itenerary",
  "travel",
  "trip",
  "vacation",
  "holiday",
  "flights",
  "flight",
  "airline",
  "hotel",
  "hotels",
  "accommodation",
  "hostel",
  "restaurants",
  "restaurant",
  "dining",
  "nightlife",
  "visa",
  "weather",
  "coffee",
  "cafe",
  "cafÃ©",
  "espresso",
  "pour over",
  "pourover",
  "cold brew",
  "roaster",
  "roastery",
  "opening hours",
  "branches",
];

const WEB_SEARCH_ROLE_HINTS = [
  "research",
  "source",
  "analyst",
  "fact",
  "verify",
  "logistics",
  "travel",
  "flight",
  "accommodation",
  "hotel",
  "booking",
  "restaurant",
  "culinary",
  "activity",
  "planner",
  "coordinator",
  "coffee",
  "cafe",
  "cafÃ©",
  "roaster",
  "roastery",
  "curator",
  "tasting",
];

function promptNeedsWebSearch(userPrompt) {
  const normalized = String(userPrompt || "").toLowerCase();
  return WEB_SEARCH_TRIGGERS.some((keyword) => normalized.includes(keyword));
}

function scoreAgentForWebSearch(spec, userPrompt) {
  const haystack = `${spec.name} ${spec.role} ${spec.focus}`.toLowerCase();
  const promptLower = String(userPrompt || "").toLowerCase();
  let score = 0;

  for (const hint of WEB_SEARCH_ROLE_HINTS) {
    if (haystack.includes(hint)) {
      score += 2;
    }
  }

  if (promptLower.includes("itinerary") || promptLower.includes("travel") || promptLower.includes("trip")) {
    if (haystack.includes("logistics") || haystack.includes("flight")) score += 6;
    if (haystack.includes("accommodation") || haystack.includes("hotel") || haystack.includes("hostel")) score += 6;
    if (haystack.includes("culinary") || haystack.includes("restaurant") || haystack.includes("nightlife")) score += 5;
    if (haystack.includes("activity") || haystack.includes("planner")) score += 4;
  }

  if (
    promptLower.includes("coffee") ||
    promptLower.includes("cafe") ||
    promptLower.includes("cafÃ©") ||
    promptLower.includes("espresso") ||
    promptLower.includes("pourover") ||
    promptLower.includes("pour over")
  ) {
    if (haystack.includes("coffee") || haystack.includes("cafe") || haystack.includes("cafÃ©")) score += 7;
    if (haystack.includes("curator") || haystack.includes("roast") || haystack.includes("roaster")) score += 6;
    if (haystack.includes("logistics") || haystack.includes("route")) score += 5;
    if (haystack.includes("tasting") || haystack.includes("sequenc") || haystack.includes("pairing")) score += 4;
  }

  if (
    promptLower.includes("research") ||
    promptLower.includes("sources") ||
    promptLower.includes("citations") ||
    promptLower.includes("latest")
  ) {
    if (haystack.includes("research") || haystack.includes("source") || haystack.includes("analyst")) score += 7;
  }

  if (Array.isArray(spec.tools) && spec.tools.includes("web_search")) {
    score += 3;
  }

  return score;
}

function buildWebSearchQuery(agent, userPrompt) {
  const parts = [
    String(userPrompt || "").trim(),
    humanizeAgentLabel(agent.role || agent.name),
    String(agent.focus || "").trim(),
  ]
    .filter(Boolean)
    .join(" ");

  return parts.replace(/\s+/g, " ").trim().slice(0, 180);
}

function applyWebSearchAssignment(agentSpecs, userPrompt, maxToolAgents = 2) {
  if (!SERPER_API_KEY) {
    return agentSpecs.map((spec) => ({ ...spec, tools: [] }));
  }

  const specs = agentSpecs.map((spec) => ({ ...spec, tools: sanitizeTools(spec.tools) }));
  const wantsSearch = promptNeedsWebSearch(userPrompt);
  const assigned = specs.filter((spec) => spec.tools.includes("web_search"));

  if (!wantsSearch && assigned.length === 0) {
    return specs;
  }

  const scored = specs
    .map((spec, index) => ({ index, score: scoreAgentForWebSearch(spec, userPrompt) }))
    .sort((a, b) => b.score - a.score);

  const keep = new Set();
  for (const entry of scored) {
    if (keep.size >= maxToolAgents) break;
    if (entry.score <= 0) continue;
    keep.add(entry.index);
  }

  if (keep.size === 0 && wantsSearch && specs.length) {
    keep.add(0);
  }

  return specs.map((spec, index) => {
    if (keep.has(index)) {
      return { ...spec, tools: ["web_search"] };
    }
    return { ...spec, tools: [] };
  });
}

// ─────────────────────────────────────────────────────────────
// COSMIC core: shared memory, task brief, SSA, heartbeat
// (See COSMIC paper §III and task-healthcare.ipynb.)
// ─────────────────────────────────────────────────────────────

// M_t: FIFO rolling shared-memory buffer of the last N agent messages.
function createSharedMemory(size = COSMIC_N) {
  return {
    size,
    entries: [], // [{ name, role, content, turn, isTool? }]
    full: [],    // full transcript for final answer + UI replay (never truncated in-place)
  };
}

// Append a new message to M_t, drop oldest if > N.
function appendMemory(mem, entry) {
  mem.entries.push(entry);
  mem.full.push(entry);
  while (mem.entries.length > mem.size) {
    mem.entries.shift();
  }
}

// Convert M_t entries into chat-completion messages for a specialist.
// The task brief D is always prepended as a pinned system message.
function memoryToChatMessages(mem, brief) {
  const msgs = [];
  if (brief) {
    msgs.push({ role: "system", content: formatTaskBriefForPrompt(brief) });
  }
  for (const entry of mem.entries) {
    msgs.push({
      role: entry.role === "user" ? "user" : "assistant",
      name: entry.name,
      content: `${entry.name}: ${entry.content}`,
    });
  }
  return msgs;
}

// Recency vector r_t: turns since each candidate last spoke.
function recencyVector(mem, agentNames) {
  const lastTurnByAgent = new Map();
  for (const entry of mem.full) {
    if (typeof entry.turn === "number" && entry.name) {
      lastTurnByAgent.set(entry.name, entry.turn);
    }
  }
  const currentTurn = mem.full.length - 1;
  const r = new Map();
  for (const name of agentNames) {
    const last = lastTurnByAgent.has(name) ? lastTurnByAgent.get(name) : -1;
    r.set(name, currentTurn - last);
  }
  return r;
}

// Render the task brief D as a stable, pinned prompt block.
function formatTaskBriefForPrompt(brief) {
  if (!brief) return "";
  const lines = ["=== COSMIC Task Brief (pinned, always in context) ==="];
  if (brief.task_summary) {
    lines.push(`Task: ${brief.task_summary}`);
  }
  if (Array.isArray(brief.constraints) && brief.constraints.length) {
    lines.push("");
    lines.push("Constraints (must be satisfied):");
    for (const c of brief.constraints) {
      lines.push(`- ${c}`);
    }
  }
  if (Array.isArray(brief.subtasks) && brief.subtasks.length) {
    lines.push("");
    lines.push("Subtasks:");
    for (const sub of brief.subtasks) {
      const depPart = Array.isArray(sub.deps) && sub.deps.length ? ` (depends on: ${sub.deps.join(", ")})` : "";
      lines.push(`- ${sub.id} [${sub.assignee}]: ${sub.description}${depPart}`);
    }
    lines.push("");
    lines.push(
      "When you contribute, reference the subtask id you are addressing (e.g., 'Addressing g2:')."
    );
  }
  lines.push("=== End Task Brief ===");
  return lines.join("\n");
}

// Leader emits the structured Task Brief D at t=0.
async function generateTaskBrief(userPrompt, agents, leaderFocus, taskSummary) {
  const agentSummaries = agents
    .map((a) => `- ${a.name} (${a.role}): ${a.focus || "(no focus)"}`)
    .join("\n");

  const systemPrompt = [
    "You are the Leader in the COSMIC multi-agent framework.",
    "You have just been assembled a crew of specialists. Your first job (turn t=0) is to emit a STRUCTURED TASK BRIEF D.",
    "",
    "The task brief will be pinned outside the rolling memory and shown to every specialist on every turn.",
    "It MUST be a decomposition of the user's task into explicit subtasks, with one assignee per subtask.",
    "",
    "Return ONLY a JSON object with this exact shape (no prose, no markdown fences):",
    "{",
    '  "task_summary": "<one sentence restating the objective>",',
    '  "constraints": ["<hard constraint 1>", "<hard constraint 2>", ...],',
    '  "subtasks": [',
    '    { "id": "g1", "description": "<narrow, verifiable subtask>", "assignee": "<specialist name from the crew>", "deps": [] },',
    '    { "id": "g2", "description": "...", "assignee": "...", "deps": ["g1"] }',
    "  ]",
    "}",
    "",
    "Rules:",
    "- Subtask ids are g1, g2, g3, ... in order.",
    "- Every subtask's assignee MUST be one of the specialist names below (never 'Leader', never a name not in the crew).",
    "- Use 3-6 subtasks; cover the full path from user request to final answer.",
    "- Constraints capture hard user requirements (length limits, format, domain rules, forbidden actions). Extract them from the user prompt.",
    "- deps is a list of subtask ids that must complete first; use [] for independent subtasks.",
  ].join("\n");

  const userMessage = [
    `User task: ${userPrompt}`,
    "",
    `Leader focus: ${leaderFocus || "Coordinate the specialists."}`,
    `Task summary (draft): ${taskSummary || userPrompt.slice(0, 160)}`,
    "",
    "Specialists in your crew:",
    agentSummaries,
    "",
    "Emit the JSON task brief now.",
  ].join("\n");

  const agentNames = new Set(agents.map((a) => a.name));
  let brief = null;
  try {
    const text = await callOpenAIChatTextWithFallback(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      {
        model: LEADER_MODEL,
        temperature: 0.2,
        reasoning_effort: isO1Model(LEADER_MODEL) ? "low" : undefined,
        max_tokens: LEADER_MAX_OUTPUT_TOKENS,
        response_format: isO1Model(LEADER_MODEL) ? undefined : { type: "json_object" },
      }
    );
    brief = safeJsonParse(text);
  } catch {
    brief = null;
  }

  return sanitizeBrief(brief, userPrompt, agents, taskSummary);
}

function sanitizeBrief(raw, userPrompt, agents, taskSummary) {
  const agentNames = agents.map((a) => a.name);
  const agentSet = new Set(agentNames);
  const safe = {
    task_summary: "",
    constraints: [],
    subtasks: [],
  };

  if (raw && typeof raw === "object") {
    safe.task_summary = String(raw.task_summary || taskSummary || userPrompt).trim().slice(0, 400);
    if (Array.isArray(raw.constraints)) {
      safe.constraints = raw.constraints
        .map((c) => String(c || "").trim())
        .filter(Boolean)
        .slice(0, 10);
    }
    if (Array.isArray(raw.subtasks)) {
      let idx = 1;
      for (const sub of raw.subtasks.slice(0, 8)) {
        if (!sub || typeof sub !== "object") continue;
        const description = String(sub.description || sub.desc || sub.goal || "").trim();
        if (!description) continue;
        let assignee = String(sub.assignee || sub.assigned_to || "").trim();
        if (!agentSet.has(assignee)) {
          // fall back to the (idx-1)-th agent round-robin
          assignee = agentNames[(idx - 1) % agentNames.length];
        }
        const deps = Array.isArray(sub.deps) ? sub.deps.map((d) => String(d).trim()).filter(Boolean) : [];
        safe.subtasks.push({
          id: sub.id ? String(sub.id).trim() : `g${idx}`,
          description,
          assignee,
          deps,
        });
        idx += 1;
      }
    }
  }

  if (!safe.task_summary) {
    safe.task_summary = (taskSummary || userPrompt).trim().slice(0, 400);
  }
  if (!safe.subtasks.length) {
    // Minimal fallback: one subtask per specialist, in order.
    safe.subtasks = agents.map((a, i) => ({
      id: `g${i + 1}`,
      description: a.focus || `Contribute ${a.role}'s perspective to the task.`,
      assignee: a.name,
      deps: i === 0 ? [] : [`g${i}`],
    }));
  }
  return safe;
}

// Parse an explicit next-speaker nomination from the most recent message.
function parseNomination(lastEntry, candidateNames) {
  if (!lastEntry || !lastEntry.content) return null;
  const content = String(lastEntry.content);
  const tail = content.split(/\r?\n/).slice(-15).join("\n");
  const candidates = candidateNames.map((n) => ({ name: n, lower: n.toLowerCase() }));

  // Prefer the last explicit "Next speaker: X" line.
  const explicitPatterns = [
    /next\s+speaker\s*[:\-]\s*([A-Za-z0-9_]+)/i,
    /(?:pass|hand\s*over|hand\s*off)\s+to\s+([A-Za-z0-9_]+)/i,
    /([A-Za-z0-9_]+)\s*,?\s*please\s+(?:go|respond|take\s+over|continue)/i,
    /\*\*([A-Za-z0-9_]+)\*\*\s*:/,
  ];
  for (const re of [...explicitPatterns].reverse()) {
    const matches = [...tail.matchAll(new RegExp(re, "gi"))];
    if (matches.length) {
      const token = (matches[matches.length - 1][1] || "").toLowerCase();
      const hit = candidates.find((c) => c.lower === token);
      if (hit) return hit.name;
    }
  }

  // Fallback: scan last few lines for a bare "Name:" at line start.
  const lines = tail.split(/\r?\n/).reverse();
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9_]{1,64})\s*:/);
    if (!m) continue;
    const token = m[1].toLowerCase();
    const hit = candidates.find((c) => c.lower === token);
    if (hit) return hit.name;
  }
  return null;
}

// SSA: selects the next speaker per Algorithm 1 in the COSMIC paper.
// Returns { chosen, reason, candidates, recency }
async function ssaSelectNextSpeaker(mem, allAgents, state) {
  const lastEntry = mem.entries[mem.entries.length - 1] || null;
  const lastSpeaker = lastEntry?.name || null;
  const turn = state.turn;

  // t = 0: Leader always opens.
  if (turn === 0) {
    return { chosen: LEADER_NAME, reason: "first_turn", candidates: [LEADER_NAME], recency: {} };
  }

  // Forced Leader heartbeat every T_leader turns (unless Leader just spoke).
  if (turn > 0 && turn % COSMIC_T_LEADER === 0 && lastSpeaker !== LEADER_NAME) {
    return {
      chosen: LEADER_NAME,
      reason: "heartbeat",
      candidates: [LEADER_NAME],
      recency: {},
    };
  }

  // Anti-self-invocation: exclude last speaker.
  const candidates = allAgents.map((a) => a.name).filter((n) => n !== lastSpeaker);

  // Rule 1: respect a valid nomination from the last message.
  const nominated = parseNomination(lastEntry, candidates);
  if (nominated) {
    return {
      chosen: nominated,
      reason: "nomination",
      candidates,
      recency: {},
    };
  }

  // Rule 2 + 3: context-relevance via a tiny LLM call, fall back to recency fairness.
  const recency = recencyVector(mem, candidates);
  const recencyObj = Object.fromEntries(recency);

  const recentBlocks = [];
  for (let i = mem.entries.length - 1; i >= 0 && recentBlocks.length < 6; i -= 1) {
    const e = mem.entries[i];
    if (!e || !e.content) continue;
    const content = String(e.content).replace(/\s+/g, " ").slice(0, 220);
    recentBlocks.push(`${e.name}: ${content}`);
  }
  const context = recentBlocks.reverse().join("\n");

  const selectorPrompt = [
    "You are the COSMIC Speaker Selector Agent (SSA).",
    `Choose the next speaker from: ${candidates.join(", ")}.`,
    "Rules:",
    `- Never choose ${lastSpeaker}.`,
    "- Prefer an agent whose domain matches what the last message asks for.",
    "- Prefer an agent who has been idle longer (higher recency is more idle).",
    "",
    `Recency (turns since last spoke): ${JSON.stringify(recencyObj)}`,
    "",
    "Recent conversation:",
    context,
    "",
    "Return ONLY the chosen agent name, nothing else.",
  ].join("\n");

  try {
    const selectorIsO1 = isO1Model(SELECTOR_MODEL);
    const selectorMaxTokens = selectorIsO1
      ? SELECTOR_MAX_OUTPUT_TOKENS_O1
      : SELECTOR_MAX_OUTPUT_TOKENS_DEFAULT;
    const response = await callOpenAIChatTextWithFallback(
      [
        { role: "system", content: "Return a single agent name from the candidate list. No other text." },
        { role: "user", content: selectorPrompt },
      ],
      {
        model: SELECTOR_MODEL,
        temperature: 0,
        max_tokens: selectorMaxTokens,
        reasoning_effort: selectorIsO1 ? "low" : undefined,
      }
    );
    const normalized = String(response || "").toLowerCase();
    const hit = candidates.find((n) => normalized.includes(n.toLowerCase()));
    if (hit) {
      return { chosen: hit, reason: "relevance", candidates, recency: recencyObj };
    }
  } catch {
    // fall through to fairness
  }

  // Rule 3 fallback: most idle candidate.
  let bestName = candidates[0];
  let bestScore = -Infinity;
  for (const name of candidates) {
    const score = recency.get(name) ?? Number.MAX_SAFE_INTEGER;
    if (score > bestScore) {
      bestScore = score;
      bestName = name;
    }
  }
  return { chosen: bestName, reason: "fairness", candidates, recency: recencyObj };
}

// Leader heartbeat: compute C(t), H(t), subtask statuses; decide termination.
// Returns { terminate, progressMessage, scores, statuses, raw }.
async function leaderHeartbeat(brief, mem, prevScores, userPrompt) {
  const transcript = mem.entries
    .map((e) => `${e.name}: ${String(e.content || "").slice(0, 800)}`)
    .join("\n---\n");

  const subtaskList = brief.subtasks
    .map((s) => `${s.id} [${s.assignee}]: ${s.description}`)
    .join("\n");

  const systemPrompt = [
    "You are the Leader's heartbeat evaluator in COSMIC.",
    "Read the rolling memory and the task brief, then emit a JSON object that estimates coverage, consistency, and per-subtask status.",
    "",
    "Return ONLY a JSON object of this exact shape:",
    "{",
    '  "subtask_statuses": { "g1": "complete"|"in_progress"|"pending", ... },',
    '  "consistency_score": <integer 0..10>,',
    '  "inconsistencies": ["<specific contradiction or constraint violation>", ...],',
    '  "progress_note": "<one short paragraph: what to do next and who should do it>",',
    '  "ready_to_terminate": <true|false>',
    "}",
    "",
    "Guidance:",
    "- A subtask is 'complete' only if the rolling memory shows concrete, acceptable output for it.",
    "- consistency_score is 10 when there are no contradictions and all user constraints are satisfied; lower when issues exist.",
    "- inconsistencies is a short list of concrete problems (empty if none).",
    "- progress_note must name specific specialists and specific subtasks if work remains.",
    "- ready_to_terminate is true ONLY when ALL subtasks are complete AND consistency is >=8 AND no inconsistencies remain.",
  ].join("\n");

  const userMessage = [
    `User task: ${userPrompt}`,
    "",
    "Task brief constraints:",
    ...(brief.constraints || []).map((c) => `- ${c}`),
    "",
    "Subtasks:",
    subtaskList,
    "",
    "Rolling shared memory (last N turns):",
    transcript || "(empty)",
    "",
    "Emit the JSON now.",
  ].join("\n");

  let parsed = null;
  try {
    const text = await callOpenAIChatTextWithFallback(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      {
        model: LEADER_MODEL,
        temperature: 0.1,
        reasoning_effort: isO1Model(LEADER_MODEL) ? "low" : undefined,
        max_tokens: LEADER_MAX_OUTPUT_TOKENS,
        response_format: isO1Model(LEADER_MODEL) ? undefined : { type: "json_object" },
      }
    );
    parsed = safeJsonParse(text);
  } catch {
    parsed = null;
  }

  const statuses = {};
  for (const sub of brief.subtasks) {
    const raw = parsed?.subtask_statuses?.[sub.id];
    const normalized =
      raw === "complete" || raw === "in_progress" || raw === "pending" ? raw : "pending";
    statuses[sub.id] = normalized;
  }

  const totalSubtasks = brief.subtasks.length || 1;
  const completeCount = Object.values(statuses).filter((s) => s === "complete").length;
  const coverage = completeCount / totalSubtasks;

  const rawH = Number(parsed?.consistency_score);
  const consistency = Number.isFinite(rawH) ? Math.max(0, Math.min(10, rawH)) / 10 : 0;

  const inconsistencies = Array.isArray(parsed?.inconsistencies)
    ? parsed.inconsistencies.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const progressNote = String(parsed?.progress_note || "").trim();
  const readyFlag = Boolean(parsed?.ready_to_terminate);

  // Stability: both C(t) and H(t) must be stable across two consecutive heartbeats.
  let stable = false;
  if (prevScores) {
    stable =
      Math.abs(coverage - prevScores.coverage) <= COSMIC_EPS_C &&
      Math.abs(consistency - prevScores.consistency) <= COSMIC_EPS_H;
  }

  const tau =
    coverage >= 1 &&
    consistency >= COSMIC_THETA_H &&
    inconsistencies.length === 0 &&
    readyFlag &&
    stable;

  return {
    terminate: tau,
    scores: { coverage, consistency, stable },
    statuses,
    inconsistencies,
    progressNote,
    readyFlag,
  };
}

// Compose a human-facing progress message from the heartbeat output.
function formatHeartbeatProgress(heartbeat, brief) {
  const pending = brief.subtasks
    .filter((s) => heartbeat.statuses[s.id] !== "complete")
    .map((s) => `- ${s.id} (${s.assignee}): ${s.description} [${heartbeat.statuses[s.id]}]`);
  const lines = [];
  lines.push(
    `Heartbeat check: coverage ${(heartbeat.scores.coverage * 100).toFixed(0)}%, consistency ${(
      heartbeat.scores.consistency * 10
    ).toFixed(1)}/10${heartbeat.scores.stable ? " (stable)" : ""}.`
  );
  if (heartbeat.inconsistencies.length) {
    lines.push("Issues to resolve:");
    for (const issue of heartbeat.inconsistencies) {
      lines.push(`- ${issue}`);
    }
  }
  if (pending.length) {
    lines.push("Outstanding subtasks:");
    lines.push(...pending);
  }
  if (heartbeat.progressNote) {
    lines.push("");
    lines.push(heartbeat.progressNote);
  }
  // Keep the conversation moving: nominate the first pending assignee.
  const firstPending = brief.subtasks.find((s) => heartbeat.statuses[s.id] !== "complete");
  if (firstPending) {
    lines.push("");
    lines.push(`Next speaker: ${firstPending.assignee}`);
  }
  return lines.join("\n");
}

const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get(["/demo", "/demo/"], (req, res) => {
  res.sendFile(path.join(__dirname, "public", "demo.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const wsSessions = new WeakMap();

function getWsSession(ws) {
  const existing = wsSessions.get(ws);
  if (existing) return existing;

  const session = {
    phase: "idle",
    runId: null,
    pending: null,
  };
  wsSessions.set(ws, session);
  return session;
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function safeJsonParse(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) {
    throw new Error("Empty planner output.");
  }

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    // fall through
  }

  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("No JSON object found in planner output.");
  }
  return JSON.parse(match[0]);
}

async function callOpenAIChatRaw(messages, options = {}) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set.");
  }

  const model = options.model || OPENAI_MODEL;
  const maxTokens = options.max_completion_tokens ?? options.max_tokens ?? MAX_OUTPUT_TOKENS;
  const cachedTempSupport = modelTemperatureSupported.get(model);
  let omitTemperature =
    isO1Model(model) || isGpt5FamilyModel(model) || cachedTempSupport === false;

  const budgetScale = modelInputCharBudgetScale.get(model) || 1;
  let messageCharBudget = Math.max(Math.floor(MAX_INPUT_CHARS * budgetScale), 2000);
  let currentMessages = trimMessagesToMaxChars(messages, messageCharBudget);

  const wantsStream =
    ENABLE_STREAMING &&
    typeof options.onDelta === "function" &&
    !options.tools &&
    !options.response_format;

  const buildBasePayload = () => {
    const payload = { model, messages: currentMessages };
    if (!omitTemperature) {
      payload.temperature = options.temperature ?? 0.3;
    }
    if (options.reasoning_effort) {
      payload.reasoning_effort = options.reasoning_effort;
    }
    return payload;
  };

  const attachTooling = (payload) => {
    if (options.tools) {
      payload.tools = options.tools;
    }

    if (options.tool_choice) {
      payload.tool_choice = options.tool_choice;
    }

    return payload;
  };

  const postChat = async (payload) => {
    const response = await fetchFn(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`OpenAI API error: ${response.status} ${text}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      const parseError = new Error("OpenAI API returned non-JSON response.");
      parseError.status = response.status;
      parseError.body = text;
      throw parseError;
    }

    const choice = data.choices?.[0];
    if (!choice || !choice.message) {
      const schemaError = new Error("OpenAI API returned an unexpected response schema.");
      schemaError.status = response.status;
      schemaError.body = text;
      throw schemaError;
    }

    return {
      message: choice.message,
      finish_reason: choice.finish_reason,
      usage: data.usage,
    };
  };

  const postChatStream = async (payload) => {
    const response = await fetchFn(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...payload, stream: true }),
    });

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`OpenAI API error: ${response.status} ${text}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }

    const body = response.body;
    if (!body) {
      const error = new Error("OpenAI API returned an empty streaming response.");
      error.status = response.status;
      throw error;
    }

    let buffer = "";
    let content = "";
    let finishReason = null;

    for await (const chunk of body) {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") {
          buffer = "";
          break;
        }

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const choice = parsed.choices?.[0];
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }
        const delta = choice?.delta;
        if (delta && typeof delta.content === "string" && delta.content) {
          content += delta.content;
          try {
            options.onDelta(delta.content);
          } catch {
            // ignore callback errors
          }
        }
      }
    }

    return {
      message: { role: "assistant", content },
      finish_reason: finishReason,
      usage: null,
    };
  };

  const buildPayload = (tokenParam, tokens) => {
    const payload = attachTooling({
      ...buildBasePayload(),
      [tokenParam]: tokens,
    });
    if (options.response_format) {
      payload.response_format = options.response_format;
    }
    return payload;
  };

  let tokenParam = modelTokenParamPreference.get(model) || "max_completion_tokens";
  let result;

  const runWithFallbackTokenParam = async (tokens) => {
    try {
      const payload = buildPayload(tokenParam, tokens);
      return wantsStream ? await postChatStream(payload) : await postChat(payload);
    } catch (error) {
      const body = String(error?.body || "");
      const lowered = body.toLowerCase();
      if (
        tokenParam === "max_completion_tokens" &&
        error?.status === 400 &&
        lowered.includes("unsupported parameter") &&
        body.includes("max_completion_tokens")
      ) {
        tokenParam = "max_tokens";
        modelTokenParamPreference.set(model, tokenParam);
        const payload = buildPayload(tokenParam, tokens);
        return wantsStream ? await postChatStream(payload) : await postChat(payload);
      }

      if (
        error?.status === 400 &&
        (lowered.includes("context_length_exceeded") ||
          lowered.includes("maximum context length") ||
          lowered.includes("please reduce your prompt") ||
          lowered.includes("too many tokens") ||
          lowered.includes("maximum context") ||
          lowered.includes("context length"))
      ) {
        const prevScale = modelInputCharBudgetScale.get(model) || 1;
        const nextScale = Math.max(prevScale * 0.7, 0.2);
        modelInputCharBudgetScale.set(model, nextScale);
        messageCharBudget = Math.max(Math.floor(MAX_INPUT_CHARS * nextScale), 2000);
        currentMessages = trimMessagesToMaxChars(messages, messageCharBudget);
        const payload = buildPayload(tokenParam, tokens);
        return wantsStream ? await postChatStream(payload) : await postChat(payload);
      }

      if (
        error?.status === 400 &&
        (body.includes("Unsupported parameter: 'temperature'") ||
          lowered.includes("temperature' does not support") ||
          lowered.includes("only the default (1) value is supported") ||
          (lowered.includes("\"param\":\"temperature\"") &&
            (lowered.includes("unsupported_parameter") ||
              lowered.includes("unsupported_value") ||
              lowered.includes("unsupported parameter") ||
              lowered.includes("unsupported value"))))
      ) {
        omitTemperature = true;
        modelTemperatureSupported.set(model, false);
        const payload = buildPayload(tokenParam, tokens);
        return wantsStream ? await postChatStream(payload) : await postChat(payload);
      }

      if (
        error?.status === 400 &&
        body.includes("Could not finish the message because max_tokens")
      ) {
        const bumpedTokens = Math.min(
          Math.max(tokens * 2, tokens + 200, 500),
          MAX_OUTPUT_TOKENS
        );
        const payload = buildPayload(tokenParam, bumpedTokens);
        return wantsStream ? await postChatStream(payload) : await postChat(payload);
      }

      if (error?.status === 400 && (lowered.includes("max_tokens") || lowered.includes("max_completion_tokens"))) {
        const limitMatch = body.match(/must be\s*(?:<=|less than or equal to)\s*(\d+)/i);
        if (limitMatch) {
          const limit = Number(limitMatch[1]);
          if (Number.isFinite(limit) && limit > 0) {
            const clamped = Math.min(tokens, limit);
            return await postChat(buildPayload(tokenParam, clamped));
          }
        }
      }

      throw error;
    }
  };

  result = await runWithFallbackTokenParam(maxTokens);

  const content = typeof result.message.content === "string" ? result.message.content.trim() : "";
  const hasToolCalls =
    Array.isArray(result.message.tool_calls) && result.message.tool_calls.length > 0;

  if (!hasToolCalls && !content) {
    const shouldRetry =
      result.finish_reason === "length" ||
      Number(result.usage?.completion_tokens_details?.reasoning_tokens || 0) > 0;
    if (shouldRetry) {
      const retryFloor = isGpt5FamilyModel(model)
        ? Math.max(1500, maxTokens + 200)
        : Math.max(400, maxTokens + 200);
      const retryTokens = Math.min(
        Math.max(Math.ceil(maxTokens * 2), retryFloor),
        MAX_OUTPUT_TOKENS
      );
      if (retryTokens > maxTokens) {
        result = await runWithFallbackTokenParam(retryTokens);
      }
    }
  }

  return result.message;
}

async function callOpenAIChatText(messages, options = {}) {
  const message = await callOpenAIChatRaw(messages, options);
  return (message.content || "").trim();
}

async function callOpenAIChatTextWithFallback(messages, options = {}) {
  try {
    return await callOpenAIChatText(messages, options);
  } catch (error) {
    const requestedModel = options.model;
    if (requestedModel && requestedModel !== OPENAI_MODEL) {
      return await callOpenAIChatText(messages, { ...options, model: OPENAI_MODEL });
    }
    throw error;
  }
}

async function callOpenAIChatRawWithFallback(messages, options = {}) {
  try {
    return await callOpenAIChatRaw(messages, options);
  } catch (error) {
    const requestedModel = options.model;
    if (requestedModel && requestedModel !== OPENAI_MODEL) {
      return await callOpenAIChatRaw(messages, { ...options, model: OPENAI_MODEL });
    }
    throw error;
  }
}

async function callPlanner(systemPrompt, userPrompt) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  try {
    return await callOpenAIChatText(messages, {
      model: PLANNER_MODEL,
      temperature: 0.2,
      max_tokens: PLANNER_MAX_OUTPUT_TOKENS,
      response_format: { type: "json_object" },
    });
  } catch (error) {
    if (PLANNER_MODEL !== OPENAI_MODEL) {
      return await callOpenAIChatText(messages, {
        model: OPENAI_MODEL,
        temperature: 0.2,
        max_tokens: PLANNER_MAX_OUTPUT_TOKENS,
        response_format: { type: "json_object" },
      });
    }
    throw error;
  }
}

async function optimizeUserPrompt(rawPrompt) {
  const prompt = String(rawPrompt || "").trim();
  if (!ENABLE_PROMPT_OPTIMIZER || !prompt) {
    return prompt;
  }

  const systemPrompt = [
    "You are a Prompt Optimizer for a multi-agent system.",
    "Rewrite the user's prompt to maximize clarity and solution quality while preserving the exact intent.",
    "Add missing constraints only as explicit assumptions (do not ask questions).",
    "Keep it concise and actionable; avoid fluff.",
    "Output ONLY the optimized prompt text (no headings, no quotes, no commentary).",
  ].join("\n");

  const userPrompt = [
    "User prompt:",
    prompt,
    "",
    "Return the optimized prompt now.",
  ].join("\n");

  const text = await callOpenAIChatTextWithFallback(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    {
      model: OPTIMIZER_MODEL,
      temperature: 0.2,
      max_tokens: MAX_OUTPUT_TOKENS,
    }
  );

  const cleaned = String(text || "").trim();
  return cleaned || prompt;
}

async function getClarificationQuestions(prompt) {
  const cleaned = String(prompt || "").trim();
  if (!ENABLE_USER_CLARIFICATIONS || !cleaned || MAX_CLARIFICATION_QUESTIONS <= 0) {
    return [];
  }

  const systemPrompt = [
    "You are a Clarification Agent for a deep research assistant.",
    "Given the user's prompt, decide if asking the user clarifying questions would materially improve the final answer.",
    `Return ONLY JSON: {\"questions\": [..]} where questions is an array of 0-${MAX_CLARIFICATION_QUESTIONS} short questions.`,
    "Ask only high-impact questions whose answers change the output (constraints, scope, preferences, required format, missing inputs).",
    "If the prompt is already specific enough, return an empty questions array.",
    "Do NOT include any other keys.",
  ].join("\n");

  const userPrompt = [
    "User prompt:",
    cleaned,
    "",
    "Return JSON now.",
  ].join("\n");

  const text = await callOpenAIChatTextWithFallback(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    {
      model: CLARIFIER_MODEL,
      temperature: 0.2,
      max_tokens: Math.min(800, MAX_OUTPUT_TOKENS),
      response_format: { type: "json_object" },
    }
  );

  let parsed;
  try {
    parsed = safeJsonParse(text);
  } catch (error) {
    return [];
  }

  const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
  return questions
    .map((q) => String(q || "").trim())
    .filter(Boolean)
    .slice(0, MAX_CLARIFICATION_QUESTIONS);
}

function ensureTerminateAtEnd(text) {
  const cleaned = String(text || "")
    .replace(/\uFEFF/g, "")
    .trim()
    .replace(/\s*TERMINATE\s*$/i, "")
    .trimEnd();

  if (!cleaned) {
    return "TERMINATE";
  }

  return `${cleaned}\nTERMINATE`;
}

function buildTranscript(history, maxChars = 18000) {
  const blocks = [];
  let total = 0;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (!message || message.role === "tool") {
      continue;
    }

    const name = message.name || (message.role === "user" ? "User" : "Assistant");
    const content = String(message.content || "").trim();
    if (!content) {
      continue;
    }

    const block = `${name}:\n${content}`;
    const nextTotal = total + block.length + 2;
    if (nextTotal > maxChars && blocks.length) {
      break;
    }

    blocks.push(block);
    total = nextTotal;
  }

  return blocks.reverse().join("\n\n");
}

function buildFallbackPlan(userPrompt) {
  const allowTools = Boolean(SERPER_API_KEY);
  const taskSummary = String(userPrompt || "").trim().slice(0, 200);

  return {
    leader_prompt: "",
    leader_focus: "Coordinate agents, resolve conflicts, and finalize a feasible outcome.",
    task_summary: taskSummary,
    agent_specs: applyWebSearchAssignment(
      [
        {
          name: "Domain_Specialist",
          role: "Domain Specialist",
          focus: "Own the core solution and propose the main approach.",
          prompt: "",
          tools: [],
        },
        {
          name: "Research_Specialist",
          role: "Research Specialist",
          focus: "Gather key facts, options, and concrete details needed to solve the task.",
          prompt: "",
          tools: allowTools ? ["web_search"] : [],
        },
        {
          name: "Quality_Reviewer",
          role: "Quality Reviewer",
          focus: "Check constraints, correctness, edge cases, and completeness.",
          prompt: "",
          tools: [],
        },
      ],
      userPrompt
    ),
  };
}

async function planAgents(userPrompt) {
  const systemPrompt = [
    "You are the COSMIC crew planner.",
    "Your job is to pick a small crew of domain specialists who will collaborate on the user's task under a Leader agent.",
    "COSMIC uses a shared rolling memory and a speaker-selector; specialists converse with each other and the Leader, not a human.",
    "",
    "How to pick the crew (think like the COSMIC notebooks):",
    "- Read the user's task and identify the distinct domains of expertise it actually requires.",
    "- Pick 3 to 5 specialists. Five is usually ideal. One specialist per major domain; minimal role overlap.",
    "- Specialists are DOMAIN experts (e.g., Cardiologist, Plot_Designer, Algebra_Solver, Logistics_Planner), not process roles.",
    "- NEVER include meta roles: no Planner, Coordinator, Synthesizer, Orchestrator, Constraint_Checker, Critic, Reviewer, Generalist, Assistant. The Leader handles coordination.",
    "- Each agent owns ONE clearly-scoped slice of the problem that only they can do well.",
    "- Agent names: single-word identifiers with underscores for spaces (e.g., 'Infectious_Disease_Specialist'). No punctuation, no numbers unless the task demands it.",
    "",
    "Return ONLY a JSON object with this exact shape:",
    "{",
    '  "task_summary": "<one short sentence describing the overall task>",',
    '  "leader_focus": "<one short sentence: what the Leader must coordinate, integrate, and decide>",',
    '  "agents": [',
    "    {",
    '      "name": "<Specialist_Name>",',
    '      "role": "<short human-readable role title>",',
    '      "focus": "<one sentence: the narrow slice this specialist owns>",',
    '      "tools": []',
    "    }",
    "  ]",
    "}",
    "",
    "Tool rules:",
    "- The only tool available is 'web_search'. Assign it (put \"web_search\" in the tools array) ONLY to specialists whose focus genuinely requires current, real-world information (travel facts, current events, market prices, live specs, news).",
    "- For reasoning-only, creative, planning, or math tasks, leave tools as [].",
    "- Assign web_search to at most 2 specialists.",
    "",
    "Return ONLY the JSON. No prose, no markdown fences.",
  ].join("\n");

  const placeholderNames = new Set(AGENT_NAME_POOL.map((name) => name.toLowerCase()));
  const wantsLetteredAgents =
    /\bagents?\s*\([a-e](?:\s*,\s*[a-e])*\)/i.test(userPrompt) ||
    /\bagent\s*[a-e]\b/i.test(userPrompt);
  const isPlaceholderAgentName = (value) => {
    const normalized = normalizeAgentName(value, "").toLowerCase();
    if (!normalized) return false;
    if (/^agent_?\d+$/.test(normalized)) return true;
    if (wantsLetteredAgents) return false;
    return placeholderNames.has(normalized);
  };

  const buildPlanFromParsed = (parsed) => {
    let rawAgents = [];
    if (Array.isArray(parsed.agents)) {
      rawAgents = parsed.agents;
    } else if (Array.isArray(parsed.agent_specs)) {
      rawAgents = parsed.agent_specs;
    } else if (Array.isArray(parsed.agent_roles)) {
      rawAgents = parsed.agent_roles.map((role, index) => ({
        name: AGENT_NAME_POOL[index],
        role:
          String(role.title || role.role || "").trim() ||
          humanizeAgentLabel(AGENT_NAME_POOL[index]) ||
          "Specialist",
        focus: role.focus || "",
        prompt: "",
        tools: [],
      }));
    }

    rawAgents = rawAgents.slice(0, MAX_AGENTS);
    if (!rawAgents.length) {
      return null;
    }

    const usedNames = new Set();
    const agentSpecs = rawAgents.map((agent, index) => {
      const fallbackName = AGENT_NAME_POOL[index] || `Agent_${index + 1}`;
      const rawName = normalizeAgentName(agent.name, "");
      const rawRole = String(agent.role || agent.title || "").trim();
      const roleBasedName = normalizeAgentName(rawRole, "");
      const baseName =
        rawName && !isPlaceholderAgentName(rawName)
          ? rawName
          : roleBasedName && !isPlaceholderAgentName(roleBasedName)
            ? roleBasedName
            : fallbackName;

      let uniqueName = baseName;
      let suffix = 2;
      while (usedNames.has(uniqueName)) {
        uniqueName = `${baseName}_${suffix}`;
        suffix += 1;
      }
      usedNames.add(uniqueName);

      let role = rawRole || humanizeAgentLabel(uniqueName) || "Specialist";
      if (isGeneralistRole(role) || isGenericRoleLabel(role)) {
        const derived = humanizeAgentLabel(uniqueName) || "Specialist";
        role = isGenericRoleLabel(derived) ? "Specialist" : derived;
      }

      const focus = String(agent.focus || "").trim();
      const prompt = String(agent.prompt || "").trim();
      const tools = SERPER_API_KEY ? sanitizeTools(agent.tools) : [];

      return {
        name: uniqueName,
        role,
        focus,
        prompt,
        tools,
      };
    });

    const hasBadSpecs = agentSpecs.some(
      (spec) => isPlaceholderAgentName(spec.name) || isGenericRoleLabel(spec.role)
    );
    if (hasBadSpecs) {
      return null;
    }

    return {
      leader_prompt: String(parsed.leader_prompt || parsed.leaderPrompt || "").trim(),
      leader_focus: String(
        parsed.leader_focus || parsed.leaderFocus || "Coordinate agents and finalize the outcome."
      ).trim(),
      task_summary: String(parsed.task_summary || parsed.taskSummary || "").trim(),
      agent_specs: applyWebSearchAssignment(agentSpecs, userPrompt),
    };
  };

  const attempts = [
    `User prompt: ${userPrompt}`,
    [
      `User prompt: ${userPrompt}`,
      "",
      "IMPORTANT:",
      "- Use ONLY domain-specialist agent names and roles specific to this task.",
      ...(wantsLetteredAgents ? [] : ["- Do NOT use placeholder names like Agent_A/Agent_B/Agent_C."]),
      "- Do NOT use generic roles like Planner, Constraint Checker, or Synthesizer.",
    ].join("\n"),
  ];

  for (const userMessage of attempts) {
    try {
      const response = await callPlanner(systemPrompt, userMessage);
      const parsed = safeJsonParse(response);
      const plan = buildPlanFromParsed(parsed);
      if (plan) {
        return plan;
      }
    } catch (error) {
      // try next attempt
    }
  }

  return buildFallbackPlan(userPrompt);
}

function buildLeaderPrompt(agentNames, leaderFocus, taskSummary) {
  const focusLine = leaderFocus
    ? `Focus: ${leaderFocus}.`
    : "Focus: Coordinate specialists and integrate their work into a final answer.";
  const taskLine = taskSummary
    ? `Task: ${taskSummary}.`
    : "Task: Solve the user's request through coordinated collaboration.";

  return [
    "You are the Leader in the COSMIC multi-agent framework.",
    `You coordinate these specialists: ${agentNames.join(", ")}.`,
    taskLine,
    focusLine,
    "",
    "Your responsibilities:",
    "- At the start, decompose the task into explicit subtasks and assign each to the right specialist.",
    "- Monitor the rolling shared memory; identify conflicts, gaps, and unaddressed constraints.",
    "- Give specialists concrete, directive instructions (\"Cardiologist: rule out X given the new lab\").",
    "- Do NOT write the final solution content yourself - that is the specialists' job.",
    "- Be concise and high-signal. No fluff, no future-work deferrals, no asking the user follow-up questions.",
    "- When assumptions are needed, make reasonable ones and proceed.",
    "",
    "Turn-taking:",
    "- Always end your message by explicitly nominating the next speaker on a clear line (e.g., \"Next speaker: Cardiologist\").",
    "- Never prefix your message with your own name or speaker label.",
    "",
    "Termination:",
    "- Only output 'TERMINATE' on the final line when you are confident that every subtask is complete, the solution is consistent with all user constraints, and stability has been reached across heartbeats.",
    "- Before TERMINATE, produce a concise Leader summary that aggregates the specialists' contributions into the final answer.",
  ].join("\n");
}

function buildAgentPrompt(spec, collaboratorNames, taskSummary) {
  const roleLabel = String(spec.role || "").trim() || humanizeAgentLabel(spec.name) || "Specialist";
  const focus = String(spec.focus || "").trim();

  const lines = [
    `You are ${spec.name} - ${roleLabel}.`,
    `Task: ${taskSummary || "Collaborate with the crew to solve the user's request."}`,
    focus ? `Your focus: ${focus}.` : "Own your domain's contribution to the task.",
    "",
    "How to participate:",
    "- Stay strictly within your specialty. Do not try to do other specialists' work.",
    "- Be concise and high-signal. Short paragraphs or tight bullets; no filler.",
    "- Adapt your reasoning when new information or specialist input arrives.",
    "- Cite the subtask id (e.g., 'Addressing g2:') when the Leader's task brief uses subtask ids.",
    "- Make reasonable assumptions if details are missing; do not ask the user.",
    "",
    `Collaborators: ${collaboratorNames.join(", ")}. You follow the Leader's direction.`,
    "",
    "Turn-taking:",
    "- End every message by nominating the next speaker on a clear line (e.g., \"Next speaker: Leader\").",
    "- Do not prefix your message with your own name.",
  ];

  if (spec.tools && spec.tools.includes("web_search")) {
    lines.push(
      "",
      "Tool available: web_search(query). Use it only when your contribution genuinely needs current real-world facts you do not already know."
    );
  }

  return lines.join("\n");
}

async function generateAgentReply(agent, mem, brief, streamContext = null) {
  const messages = [{ role: "system", content: agent.systemPrompt }];
  const model = agent.model || OPENAI_MODEL;
  const isO1 = isO1Model(model);
  const maxOutputTokens =
    agent.name === LEADER_NAME ? LEADER_MAX_OUTPUT_TOKENS : AGENT_MAX_OUTPUT_TOKENS;
  const firstUserEntry = mem.full.find((e) => e.role === "user");
  const userPrompt = String(firstUserEntry?.content || "");
  const normalizeText = (value) => {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    return String(value);
  };

  // Pinned Task Brief D + rolling FIFO memory M_t.
  messages.push(...memoryToChatMessages(mem, brief));

  const tools =
    agent.tools && agent.tools.includes("web_search") ? [WEB_SEARCH_TOOL] : null;
  const shouldForceWebSearch =
    Boolean(tools) &&
    promptNeedsWebSearch(userPrompt) &&
    Number(agent.toolUseCount || 0) === 0;

  const onDelta =
    streamContext?.ws && streamContext?.runId && streamContext?.messageId
      ? (delta) =>
          send(streamContext.ws, {
            type: "message_delta",
            runId: streamContext.runId,
            id: streamContext.messageId,
            name: agent.name,
            delta,
          })
      : undefined;

  const canForceToolChoice = modelToolForceSupported.get(model) !== false;

  let response;
  if (shouldForceWebSearch && canForceToolChoice) {
    try {
      response = await callOpenAIChatRawWithFallback(messages, {
        model,
        temperature: 0,
        reasoning_effort: isO1 ? "low" : undefined,
        max_tokens: TOOL_CALL_MAX_TOKENS,
        tools,
        tool_choice: { type: "function", function: { name: "web_search" } },
      });
    } catch (error) {
      const body = String(error?.body || "");
      if (body.toLowerCase().includes("tool_choice") || body.toLowerCase().includes("tools")) {
        modelToolForceSupported.set(model, false);
      }
      response = null;
    }
  }

  if (!response) {
    response = await callOpenAIChatRawWithFallback(messages, {
      model,
      temperature: 0.3,
      reasoning_effort: isO1 ? "low" : undefined,
      max_tokens: maxOutputTokens,
      tools,
      tool_choice: tools ? "auto" : undefined,
      onDelta,
    });
  }

  let steps = 0;
  while (tools && response.tool_calls && response.tool_calls.length && steps < 2) {
    messages.push({
      role: "assistant",
      content: response.content || "",
      tool_calls: response.tool_calls,
    });

    const toolResults = await Promise.all(
      response.tool_calls.map(async (call) => {
        const toolName = call.function?.name;
        const toolFn = TOOL_MAP[toolName];
        let toolResult = "";

        if (!toolFn) {
          toolResult = `Tool ${toolName} is not available.`;
        } else {
          try {
            const args = JSON.parse(call.function?.arguments || "{}");
            toolResult = await toolFn(args.query || "");
          } catch (error) {
            toolResult = `Tool ${toolName} error: ${error.message}`;
          }
        }

        return { call, toolName, toolResult };
      })
    );

    for (const entry of toolResults) {
      const toolName = entry.toolName;
      let toolResult = clampText(entry.toolResult, MAX_TOOL_RESULT_CHARS);

      messages.push({
        role: "tool",
        tool_call_id: entry.call.id,
        content: toolResult,
      });

      if (toolName === "web_search") {
        agent.toolUseCount = Number(agent.toolUseCount || 0) + 1;
      }
    }

    response = await callOpenAIChatRawWithFallback(messages, {
      model,
      temperature: 0.2,
      reasoning_effort: isO1 ? "low" : undefined,
      max_tokens: maxOutputTokens,
      tools,
      onDelta: tools ? undefined : onDelta,
    });

    steps += 1;
  }

  if (shouldForceWebSearch && Number(agent.toolUseCount || 0) === 0) {
    const query = buildWebSearchQuery(agent, userPrompt);
    try {
      const results = await searchWeb(query);
      agent.toolUseCount = 1;

      const followup = [
        ...messages,
        { role: "system", content: `Web search results (query: ${query}):\n${results}` },
        { role: "user", content: "Use the web search results above to answer. Be specific." },
      ];

      const grounded = await callOpenAIChatRawWithFallback(followup, {
        model,
        temperature: 0.2,
        reasoning_effort: isO1 ? "low" : undefined,
        max_tokens: maxOutputTokens,
      });

      const groundedText = normalizeText(grounded.content).trim();
      if (groundedText) {
        return groundedText;
      }
    } catch (error) {
      // If Serper fails, proceed with the model-only answer.
    }
  }

  let finalText = normalizeText(response.content).trim();

  const isEffectivelyEmpty = (text) => {
    const cleaned = String(text || "").trim();
    if (!cleaned) return true;
    const normalized = cleaned.replace(/\s+/g, " ").replace(/:+$/, "").trim().toLowerCase();
    const agentName = String(agent.name || "").trim().toLowerCase();
    if (!normalized) return true;
    if (agentName && normalized === agentName) return true;
    if (cleaned.length < 12) return true;
    return false;
  };

  if (isEffectivelyEmpty(finalText)) {
    try {
      const retry = await callOpenAIChatRawWithFallback(
        [
          ...messages,
          {
            role: "user",
            content:
              "Your previous response was empty or unusable. Reply now with a concrete, non-empty proposal.\nRules: no speaker labels, no meta commentary, be concise but specific.",
          },
        ],
        {
          model,
          temperature: 0.2,
          reasoning_effort: isO1 ? "low" : undefined,
          max_tokens: Math.max(900, Math.floor(maxOutputTokens * 0.8)),
          tools,
        }
      );
      finalText = normalizeText(retry.content).trim();
    } catch (error) {
      // ignore and fall through
    }
  }

  if (isEffectivelyEmpty(finalText)) {
    try {
      const fallbackModel = model === OPENAI_MODEL ? LEADER_MODEL : OPENAI_MODEL;
      const retry = await callOpenAIChatRawWithFallback(
        [
          ...messages,
          {
            role: "user",
            content:
              "Reply with your proposal now.\nReturn only the answer content (no name, no preface).",
          },
        ],
        {
          model: fallbackModel,
          temperature: 0.2,
          reasoning_effort: isO1Model(fallbackModel) ? "low" : undefined,
          max_tokens: Math.max(900, maxOutputTokens),
          tools,
        }
      );
      finalText = normalizeText(retry.content).trim();
    } catch (error) {
      // ignore and fall through
    }
  }

  return finalText;
}

async function generateFinalAnswer(prompt, history, streamContext = null) {
  const normalizedHistory = Array.isArray(history)
    ? history
    : history && Array.isArray(history.full)
    ? history.full.map((e) => ({
        role: e.role === "user" ? "user" : "assistant",
        name: e.name,
        content: e.content,
      }))
    : [];
  const transcript = buildTranscript(normalizedHistory, MAX_INPUT_CHARS);
  const systemPrompt = [
    "You are the Final Answer Validator.",
    "You read the full conversation transcript and produce the final answer for the user.",
    "Validate for: completeness, correctness, internal consistency, and that it matches the user's request.",
    "If anything is missing or weak, fix it directly (do not ask questions).",
    "Output ONLY the final answer (no meta commentary, no speaker tags, no 'who speaks next').",
    "End with TERMINATE on the last line of the same message.",
  ].join("\n");

  const userPrompt = [
    "User prompt:",
    String(prompt || "").trim(),
    "",
    "Conversation transcript (for context):",
    transcript,
    "",
    "Return the final answer now.",
  ].join("\n");

  const onDelta =
    streamContext?.ws && streamContext?.runId && streamContext?.messageId
      ? (delta) =>
          send(streamContext.ws, {
            type: "message_delta",
            runId: streamContext.runId,
            id: streamContext.messageId,
            name: LEADER_NAME,
            delta,
          })
      : undefined;

  const message = await callOpenAIChatRawWithFallback(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    {
      model: FINALIZER_MODEL,
      temperature: 0.2,
      reasoning_effort: isO1Model(FINALIZER_MODEL) ? "medium" : undefined,
      max_tokens: FINALIZER_MAX_OUTPUT_TOKENS,
      onDelta,
    }
  );

  return ensureTerminateAtEnd((message.content || "").trim());
}

async function runConversationCore(finalPrompt, ws, runId) {
  if (!SERPER_API_KEY && promptNeedsWebSearch(finalPrompt)) {
    send(ws, {
      type: "status",
      runId,
      message:
        "Web search is requested but SERPER_API_KEY is not set; continuing without browsing.",
    });
  }

  send(ws, { type: "status", message: "Planning agents...", runId });
  const plan = await planAgents(finalPrompt);
  const agentNames = plan.agent_specs.map((spec) => spec.name);

  const taskSummary =
    plan.task_summary || String(finalPrompt || "").trim().slice(0, 200);

  const agents = plan.agent_specs.map((spec) => {
    const collaborators = agentNames.filter((agentName) => agentName !== spec.name);
    return {
      name: spec.name,
      role: String(spec.role || "").trim() || humanizeAgentLabel(spec.name) || "Specialist",
      focus: spec.focus || "",
      tools: sanitizeTools(spec.tools),
      model: OPENAI_MODEL,
      toolUseCount: 0,
      systemPrompt: buildAgentPrompt(
        spec,
        [LEADER_NAME, ...collaborators],
        taskSummary
      ),
    };
  });

  const leaderFocus =
    plan.leader_focus ||
    "Coordinate agents, resolve conflicts, and finalize a feasible outcome.";

  const leader = {
    name: LEADER_NAME,
    role: "Leader",
    focus: leaderFocus,
    model: LEADER_MODEL,
    toolUseCount: 0,
    systemPrompt: buildLeaderPrompt(agentNames, leaderFocus, taskSummary),
  };

  const allAgents = [leader, ...agents];

  send(ws, {
    type: "agents",
    runId,
    leader: { name: leader.name, role: leader.focus, tools: [] },
    agents: agents.map((agent) => ({
      name: agent.name,
      role: agent.role,
      tools: agent.tools || [],
    })),
  });

  // Shared rolling memory M_t (FIFO, last COSMIC_N entries) + full transcript.
  const mem = createSharedMemory(COSMIC_N);
  appendMemory(mem, { role: "user", name: "User", content: finalPrompt, turn: 0 });

  // Leader emits Task Brief D at t=0. Pinned outside the FIFO.
  send(ws, { type: "status", message: "Leader is drafting task brief...", runId });
  const brief = await generateTaskBrief(finalPrompt, agents, leaderFocus, taskSummary);
  send(ws, { type: "task_brief", runId, brief });

  send(ws, { type: "status", message: "Conversation started.", runId });

  const runFinalization = async (reason) => {
    send(ws, { type: "status", message: `${reason} Finalizing output...`, runId });
    const finalMessageId = `${runId}:final`;
    send(ws, { type: "message_start", runId, id: finalMessageId, name: LEADER_NAME });
    const finalAnswer = await generateFinalAnswer(finalPrompt, mem, {
      ws,
      runId,
      messageId: finalMessageId,
    });
    appendMemory(mem, {
      role: "assistant",
      name: LEADER_NAME,
      content: finalAnswer,
      turn: mem.full.length,
    });
    send(ws, {
      type: "message",
      runId,
      id: finalMessageId,
      name: LEADER_NAME,
      content: finalAnswer,
    });
    send(ws, { type: "final", runId, content: finalAnswer });
    send(ws, { type: "status", message: "Conversation finished.", runId });
  };

  let prevHeartbeatScores = null;

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const ssa = await ssaSelectNextSpeaker(mem, allAgents, { turn });
    const nextSpeaker = allAgents.find((a) => a.name === ssa.chosen);

    if (!nextSpeaker) {
      send(ws, { type: "error", message: "No valid speaker found.", runId });
      break;
    }

    send(ws, {
      type: "ssa_decision",
      runId,
      turn,
      chosen: ssa.chosen,
      reason: ssa.reason,
      candidates: ssa.candidates,
      recency: ssa.recency,
    });
    send(ws, { type: "speaker", name: nextSpeaker.name, runId });
    send(ws, {
      type: "status",
      message: `Turn ${turn + 1}: ${nextSpeaker.name} responding (${ssa.reason})...`,
      runId,
    });

    // Leader heartbeat path: instead of a free-form reply, compute C(t), H(t), and check tau.
    if (ssa.reason === "heartbeat" && nextSpeaker.name === LEADER_NAME) {
      const heartbeat = await leaderHeartbeat(brief, mem, prevHeartbeatScores, finalPrompt);
      send(ws, {
        type: "heartbeat",
        runId,
        turn,
        scores: heartbeat.scores,
        statuses: heartbeat.statuses,
        inconsistencies: heartbeat.inconsistencies,
        readyFlag: heartbeat.readyFlag,
      });
      send(ws, {
        type: "subtask_update",
        runId,
        statuses: heartbeat.statuses,
      });

      const progressText = formatHeartbeatProgress(heartbeat, brief);
      const messageId = `${runId}:${turn}:${LEADER_NAME}`;
      send(ws, { type: "message_start", runId, id: messageId, name: LEADER_NAME });
      send(ws, {
        type: "message",
        runId,
        id: messageId,
        name: LEADER_NAME,
        content: progressText,
      });
      appendMemory(mem, {
        role: "assistant",
        name: LEADER_NAME,
        content: progressText,
        turn: mem.full.length,
      });

      if (heartbeat.terminate) {
        await runFinalization("Termination predicate satisfied.");
        return;
      }

      prevHeartbeatScores = {
        coverage: heartbeat.scores.coverage,
        consistency: heartbeat.scores.consistency,
      };
      continue;
    }

    const messageId = `${runId}:${turn}:${nextSpeaker.name}`;
    send(ws, { type: "message_start", runId, id: messageId, name: nextSpeaker.name });
    const reply = await generateAgentReply(nextSpeaker, mem, brief, {
      ws,
      runId,
      messageId,
    });

    appendMemory(mem, {
      role: "assistant",
      name: nextSpeaker.name,
      content: reply,
      turn: mem.full.length,
    });
    send(ws, { type: "message", runId, id: messageId, name: nextSpeaker.name, content: reply });

    if (
      nextSpeaker.name === LEADER_NAME &&
      String(reply || "").trimEnd().endsWith("TERMINATE")
    ) {
      await runFinalization("Leader requested termination.");
      return;
    }
  }

  send(ws, {
    type: "status",
    message: "Max turns reached. Finalizing best-effort output...",
    runId,
  });
  await runFinalization("Max turn limit reached.");
}

async function startConversation(rawPrompt, ws, session) {
  const runId = crypto.randomUUID();
  session.runId = runId;
  session.phase = "starting";

  send(ws, { type: "status", message: "Optimizing prompt...", runId });
  const optimizedPrompt = await optimizeUserPrompt(rawPrompt);

  send(ws, { type: "status", message: "Checking for clarifications...", runId });
  const questions = await getClarificationQuestions(optimizedPrompt);

  if (questions.length) {
    session.phase = "awaiting_clarifications";
    session.pending = {
      runId,
      rawPrompt,
      optimizedPrompt,
      questions,
    };
    send(ws, {
      type: "clarify",
      runId,
      questions,
    });
    send(ws, {
      type: "status",
      message: "Waiting for your clarifications...",
      runId,
    });
    return;
  }

  session.phase = "running";
  await runConversationCore(optimizedPrompt, ws, runId);
  session.phase = "idle";
  session.pending = null;
}

async function continueConversationWithClarifications(ws, session, answers) {
  const pending = session.pending;
  if (!pending) {
    send(ws, { type: "error", message: "No clarification request is pending." });
    return;
  }

  const runId = pending.runId;
  const answerText = String(answers || "").trim();
  const combinedPrompt = [
    pending.optimizedPrompt,
    "",
    "User clarifications:",
    answerText || "(No additional clarifications provided.)",
  ].join("\n");

  send(ws, { type: "status", message: "Re-optimizing with clarifications...", runId });
  const finalPrompt = await optimizeUserPrompt(combinedPrompt);

  session.phase = "running";
  session.pending = null;
  await runConversationCore(finalPrompt, ws, runId);
  session.phase = "idle";
}

wss.on("connection", (ws) => {
  const session = getWsSession(ws);
  send(ws, { type: "status", message: "Connected. Ready when you are." });

  ws.on("message", async (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch (error) {
      send(ws, { type: "error", message: "Invalid JSON payload." });
      return;
    }

    if (payload.type === "start") {
      if (session.phase !== "idle") {
        send(ws, {
          type: "error",
          runId: session.runId || undefined,
          message:
            session.phase === "awaiting_clarifications"
              ? "Please answer the clarification questions first."
              : "A run is already in progress.",
        });
        return;
      }

      const prompt = String(payload.prompt || "").trim();
      if (!prompt) {
        send(ws, { type: "error", message: "Prompt is required." });
        return;
      }

      try {
        await startConversation(prompt, ws, session);
      } catch (error) {
        const failedRunId = session.runId;
        session.phase = "idle";
        session.pending = null;
        session.runId = null;
        send(ws, {
          type: "error",
          runId: failedRunId || undefined,
          message: error?.message || "Unexpected error while running agents.",
        });
      }
    }

    if (payload.type === "clarify_response") {
      const runId = String(payload.runId || "").trim();
      const pending = session.pending;
      if (!pending || session.phase !== "awaiting_clarifications") {
        send(ws, { type: "error", message: "No clarifications are pending." });
        return;
      }

      if (!runId || runId !== pending.runId) {
        send(ws, {
          type: "error",
          message: "Clarification runId mismatch. Please restart the run.",
        });
        session.phase = "idle";
        session.pending = null;
        session.runId = null;
        return;
      }

      const answers = payload.answers;
      try {
        await continueConversationWithClarifications(ws, session, answers);
      } catch (error) {
        session.phase = "idle";
        session.pending = null;
        session.runId = null;
        send(ws, {
          type: "error",
          runId,
          message: error?.message || "Unexpected error while applying clarifications.",
        });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Cosmic Agents server running on http://localhost:${PORT}`);
});
