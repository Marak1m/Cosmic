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
const SELECTOR_MODEL = process.env.SELECTOR_MODEL || "o1";
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
const ENABLE_MEMORY_SUMMARY = normalizeBoolean(process.env.ENABLE_MEMORY_SUMMARY ?? "true");
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || OPENAI_MODEL;
const SUMMARY_TRIGGER_CHARS = readIntEnv("SUMMARY_TRIGGER_CHARS", 60000, { min: 12000, max: 500000 });
const SUMMARY_MIN_TURNS_BETWEEN = readIntEnv("SUMMARY_MIN_TURNS_BETWEEN", 8, { min: 2, max: 50 });
const SEARCH_CACHE_TTL_MS = readIntEnv("SEARCH_CACHE_TTL_MS", 10 * 60 * 1000, { min: 0, max: 24 * 60 * 60 * 1000 });
const SEARCH_CACHE_MAX_ENTRIES = readIntEnv("SEARCH_CACHE_MAX_ENTRIES", 200, { min: 0, max: 2000 });
const SEARCH_BATCH_MAX_QUERIES = readIntEnv("SEARCH_BATCH_MAX_QUERIES", 3, { min: 1, max: 6 });

const MAX_AGENTS = 5;
const MAX_TURNS = 50;
const MEMORY_WINDOW = 50;
const LEADER_NAME = "Leader";
const LEADER_CHECKIN_INTERVAL = readIntEnv("LEADER_CHECKIN_INTERVAL", 10, { min: 3, max: 25 });

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

function initAgentMemory(agents) {
  const memoryMap = new Map();
  for (const agent of agents) {
    memoryMap.set(agent.name, []);
  }
  return {
    map: memoryMap,
    cursor: 0,
    summary: "",
    lastSummaryTurn: -1,
    lastSummaryHistoryLen: 0,
  };
}

function syncAgentMemory(history, memoryState) {
  if (!memoryState) {
    return;
  }
  for (let i = memoryState.cursor; i < history.length; i += 1) {
    const message = history[i];
    if (!message || message.role === "tool") {
      continue;
    }
    for (const memory of memoryState.map.values()) {
      memory.push({ role: message.role, name: message.name, content: message.content });
    }
  }
  memoryState.cursor = history.length;
}

function estimateHistoryChars(history) {
  if (!Array.isArray(history)) return 0;
  let total = 0;
  for (const message of history) {
    total += estimateMessageChars(message);
  }
  return total;
}

async function maybeUpdateMemorySummary(history, memoryState, turn, ws, runId) {
  if (!ENABLE_MEMORY_SUMMARY || !memoryState) return;
  if (turn - (memoryState.lastSummaryTurn ?? -1) < SUMMARY_MIN_TURNS_BETWEEN) return;
  if (history.length - (memoryState.lastSummaryHistoryLen || 0) < 8) return;

  const approxChars = estimateHistoryChars(history);
  if (approxChars < SUMMARY_TRIGGER_CHARS) return;

  if (ws && runId) {
    send(ws, { type: "status", runId, message: "Compressing shared memory for speed..." });
  }

  const transcript = buildTranscript(history, Math.min(42000, MAX_INPUT_CHARS));
  const systemPrompt = [
    "You are a memory summarizer for a multi-agent system.",
    "Summarize the conversation so far into a compact, lossless working memory.",
    "Include: task goal, key constraints, key decisions, facts found, and open items.",
    "Be concise and high-signal. Use bullet points. No fluff.",
    "Output ONLY the summary.",
  ].join("\n");

  const userPrompt = [
    "Conversation transcript:",
    transcript,
    "",
    "Return the summary now.",
  ].join("\n");

  try {
    const summary = await callOpenAIChatTextWithFallback(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      {
        model: SUMMARY_MODEL,
        temperature: 0.2,
        max_tokens: Math.min(900, MAX_OUTPUT_TOKENS),
      }
    );

    memoryState.summary = String(summary || "").trim();
    memoryState.lastSummaryTurn = turn;
    memoryState.lastSummaryHistoryLen = history.length;
  } catch {
    // ignore summary failures
  }
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
    "You are an orchestration planner for multi-agent tasks.",
    "Return ONLY JSON.",
    "Think like hiring: if you had to hire specialists to solve this task fast, who would you hire?",
    "Create distinct specialists with minimal overlap; each agent should own one part of the problem.",
    "Never create a 'Generalist' agent; roles must be specific and task-relevant.",
    "Avoid generic roles like Planner, Constraint Checker, or Synthesizer unless the task explicitly needs them.",
    "Decide 1-5 agents (not counting the Leader).",
    "Each agent must include: name, role, focus, prompt, tools.",
    "Include task_summary (1 short sentence).",
    "tools can include only: web_search. Assign it only when research is needed.",
    "If the user asks for travel itineraries, flights, hotels, restaurants, nightlife, or other real-world facts, assign web_search to the most relevant specialist(s).",
    "Agent names should reflect the role (e.g., Logistics_Manager) and use underscores only.",
    "Prompts must be minimal and follow the exact template.",
    "Leader prompt template (exact lines):",
    "You are the Leader.",
    "You oversee agents: <AGENT_LIST>.",
    "Your ONLY job is to delegate the task to the agents, gather proposals, resolve conflicts, and reassign subtasks.",
	    "You must NOT solve the task yourself or write the final solution content.",
	    "Task: <TASK_SUMMARY>.",
	    "Focus: <LEADER_FOCUS>.",
	    "Focus on converging to the answer as soon as possible; be concise and high-signal (avoid fluff and repetition).",
	    "Do not set deadlines or future work. Finish within this chat.",
	    "If required details are missing, make reasonable assumptions and proceed without asking the user.",
	    "When you are satisfied the agents have produced enough to generate the final answer, output TERMINATE as the last line to trigger finalization.",
	    "Always choose who speaks next at the end of your message unless you are outputting TERMINATE.",
    "Agent prompt template (exact lines):",
    "You are <NAME>.",
    "Role: <ROLE>.",
	    "Context: <FOCUS>.",
	    "Task: <TASK_SUMMARY>.",
	    "Tool: web_search. (only if assigned; otherwise omit this line)",
	    "Focus on converging to the answer as soon as possible; be concise and high-signal (avoid fluff and repetition).",
	    "Do not set deadlines or future work. Finish within this chat.",
	    "If required details are missing, make reasonable assumptions and proceed without asking the user.",
	    "You collaborate with <COLLABORATORS> and follow the Leader.",
	    "Always choose who speaks next at the end of your message.",
    "Use simple names with underscores; avoid spaces and punctuation.",
    "Do not include meta-process roles (Planner/Synthesizer/Constraint Checker) unless the task truly requires them; prefer domain specialists.",
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

function buildLeaderPrompt(agentNames, basePrompt, leaderFocus, taskSummary) {
  const focusLine = leaderFocus
    ? `Focus: ${leaderFocus}.`
    : "Focus: Coordinate and finalize the outcome.";
  const taskLine = taskSummary
    ? `Task: ${taskSummary}.`
    : "Task: Solve the user's request.";

  const templateLines = [
    "You are the Leader.",
    `You oversee agents: ${agentNames.join(", ")}.`,
    "Your ONLY job is to delegate the task to the agents, gather proposals, resolve conflicts, and reassign subtasks.",
    "You must NOT solve the task yourself or write the final solution content.",
    taskLine,
    focusLine,
    "Do not prefix your message with your name or speaker tags (e.g., 'Leader:' or 'Leader').",
    "Prefer one-pass delegation: ask agents for complete proposals in their next message and avoid follow-ups unless a critical gap remains.",
    "Focus on converging to the answer as soon as possible; be concise and high-signal (avoid fluff and repetition).",
    "Do not set deadlines or future work. Finish within this chat.",
    "If required details are missing, make reasonable assumptions and proceed without asking the user.",
    "When you are satisfied the agents have produced enough to generate the final answer, output TERMINATE as the last line to trigger finalization.",
    "Always choose who speaks next at the end of your message unless you are outputting TERMINATE.",
  ];

  const base = basePrompt ? ensurePromptLines(basePrompt, templateLines) : "";
  return base || templateLines.join("\n");
}

function buildAgentPrompt(spec, collaboratorNames, taskSummary) {
  const context = spec.focus
    ? `Context: ${spec.focus}.`
    : "Context: Provide support as needed.";
  const taskLine = taskSummary
    ? `Task: ${taskSummary}.`
    : "Task: Solve the user's request.";
  const roleLabel = String(spec.role || "").trim() || humanizeAgentLabel(spec.name) || "Specialist";

  const templateLines = [
    `You are ${spec.name}.`,
    `Role: ${roleLabel}.`,
    context,
    taskLine,
  ];

	if (spec.tools && spec.tools.includes("web_search")) {
	  templateLines.push("Tool: web_search.");
	}

	templateLines.push(
	  "Focus on converging to the answer as soon as possible; be concise and high-signal (avoid fluff and repetition)."
	);
	templateLines.push("Do not set deadlines or future work. Finish within this chat.");
  templateLines.push(
    "If required details are missing, make reasonable assumptions and proceed without asking the user."
  );
  templateLines.push(
    `You collaborate with ${collaboratorNames.join(", ")} and follow the Leader.`
  );
  templateLines.push(
    "Do not prefix your message with your name or speaker tags (e.g., 'Agent_X:' on its own line)."
  );
  templateLines.push("Always choose who speaks next at the end of your message.");

  const base = spec.prompt ? ensurePromptLines(spec.prompt, templateLines) : "";
  return base || templateLines.join("\n");
}

async function selectNextSpeaker(history, agents, callCount) {
  if (callCount === 0) {
    return LEADER_NAME;
  }

  const lastSpeaker = history.at(-1)?.name || "";
  const candidateNames = agents.map((agent) => agent.name);
  const eligibleCandidates = candidateNames.filter((name) => name !== lastSpeaker);
  const candidates = eligibleCandidates.length ? eligibleCandidates : candidateNames;

  if (callCount % LEADER_CHECKIN_INTERVAL === 0 && lastSpeaker !== LEADER_NAME) {
    return LEADER_NAME;
  }

  const lastMessage = String(history.at(-1)?.content || "");
  const lastLines = lastMessage.split(/\r?\n/).slice(-30);
  const hintLine = [...lastLines].reverse().find((line) =>
    /(who speaks next|next speaker|choose who speaks next)/i.test(line)
  );

  if (hintLine) {
    const hintLower = hintLine.toLowerCase();
    const hinted = candidates.find((name) =>
      hintLower.includes(name.toLowerCase())
    );
    if (hinted && hinted !== lastSpeaker) {
      return hinted;
    }
  }

  // Fast-path: if the last message explicitly assigns a subtask like "Agent_X: ...",
  // pick that agent without spending an extra model call.
  const candidateLookup = new Map(
    candidates.map((name) => [name.toLowerCase(), name])
  );
  for (const line of lastLines) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;

    const bold = trimmed.match(/\*\*([A-Za-z][A-Za-z0-9_]{1,64})\*\*\s*:/);
    const plain = trimmed.match(/^([A-Za-z][A-Za-z0-9_]{1,64})\s*:/);
    const token = (bold?.[1] || plain?.[1] || "").toLowerCase();
    if (!token) continue;
    const assigned = candidateLookup.get(token);
    if (assigned && assigned !== lastSpeaker) {
      return assigned;
    }
  }

  const recentBlocks = [];
  for (
    let index = history.length - 1;
    index >= 0 && recentBlocks.length < 8;
    index -= 1
  ) {
    const message = history[index];
    if (!message || message.role === "tool") continue;
    const name = message.name || (message.role === "user" ? "User" : "Assistant");
    const content = String(message.content || "").trim().replace(/\s+/g, " ");
    if (!content) continue;
    recentBlocks.push(`${name}: ${content.slice(0, 260)}`);
  }
  const context = recentBlocks.reverse().join("\n");

  const selectorPrompt = [
    "You are the Speaker Selector Agent (SSA).",
    `Choose the next speaker from: ${candidates.join(", ")}.`,
    "Rules:",
    "- Return ONLY a single agent name from the list.",
    `- Do NOT choose ${lastSpeaker} again immediately.`,
    "- If the last message assigns a subtask to a named agent (e.g., 'Agent_X: ...'), choose that agent.",
    "- Otherwise, choose the agent best positioned to make progress next and keep participation balanced.",
    "",
    "Recent conversation:",
    context,
  ].join("\n");

  try {
    const selectorIsO1 = isO1Model(SELECTOR_MODEL);
    const selectorMaxTokens = selectorIsO1
      ? SELECTOR_MAX_OUTPUT_TOKENS_O1
      : SELECTOR_MAX_OUTPUT_TOKENS_DEFAULT;
    const response = await callOpenAIChatTextWithFallback(
      [
        {
          role: "system",
          content: "Return a single agent name from the candidate list.",
        },
        { role: "user", content: selectorPrompt },
      ],
      {
        temperature: 0,
        model: SELECTOR_MODEL,
        max_tokens: selectorMaxTokens,
        reasoning_effort: selectorIsO1 ? "low" : undefined,
      }
    );

    const normalized = response.toLowerCase();
    const match = candidates.find((name) =>
      normalized.includes(name.toLowerCase())
    );

    return match || candidates[0];
  } catch (error) {
    return candidates[0];
  }
}

async function generateAgentReply(agent, history, memoryState, streamContext = null) {
  const memory = memoryState?.map?.get(agent.name) || [];
  const hasSummary = Boolean(String(memoryState?.summary || "").trim());
  const memoryWindow = hasSummary ? Math.min(MEMORY_WINDOW, 18) : MEMORY_WINDOW;
  const recentMemory = memory.slice(-memoryWindow);
  const messages = [{ role: "system", content: agent.systemPrompt }];
  const model = agent.model || OPENAI_MODEL;
  const isO1 = isO1Model(model);
  const maxOutputTokens =
    agent.name === LEADER_NAME ? LEADER_MAX_OUTPUT_TOKENS : AGENT_MAX_OUTPUT_TOKENS;
  const userPrompt = String(history?.[0]?.content || "");
  const normalizeText = (value) => {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    return String(value);
  };

  if (hasSummary) {
    messages.push({
      role: "system",
      content: `Shared memory summary:\n${String(memoryState.summary || "").trim()}`,
    });
  }

  if (recentMemory.length) {
    messages.push(...recentMemory);
  } else if (history.length) {
    messages.push(history[history.length - 1]);
  }

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
  const transcript = buildTranscript(history, MAX_INPUT_CHARS);
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
    systemPrompt: buildLeaderPrompt(
      agentNames,
      plan.leader_prompt,
      leaderFocus,
      taskSummary
    ),
  };

  const allAgents = [leader, ...agents];
  const memoryState = initAgentMemory(allAgents);

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

  const history = [{ role: "user", name: "User", content: finalPrompt }];
  syncAgentMemory(history, memoryState);
  let callCount = 0;

  send(ws, { type: "status", message: "Conversation started.", runId });

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const nextSpeakerName = await selectNextSpeaker(history, allAgents, callCount);
    const nextSpeaker = allAgents.find((agent) => agent.name === nextSpeakerName);

    if (!nextSpeaker) {
      send(ws, { type: "error", message: "No valid speaker found.", runId });
      break;
    }

    send(ws, { type: "speaker", name: nextSpeaker.name, runId });
    send(ws, {
      type: "status",
      message: `Turn ${turn + 1}: ${nextSpeaker.name} responding...`,
      runId,
    });

    const messageId = `${runId}:${turn}:${nextSpeaker.name}`;
    send(ws, { type: "message_start", runId, id: messageId, name: nextSpeaker.name });
    const reply = await generateAgentReply(nextSpeaker, history, memoryState, {
      ws,
      runId,
      messageId,
    });

    if (nextSpeaker.name === LEADER_NAME && String(reply || "").trimEnd().endsWith("TERMINATE")) {
      history.push({ role: "assistant", name: nextSpeaker.name, content: reply });
      syncAgentMemory(history, memoryState);

      send(ws, {
        type: "status",
        message: "Leader requested termination. Finalizing output...",
        runId,
      });
      const finalMessageId = `${runId}:final`;
      send(ws, { type: "message_start", runId, id: finalMessageId, name: LEADER_NAME });
      const finalAnswer = await generateFinalAnswer(finalPrompt, history, {
        ws,
        runId,
        messageId: finalMessageId,
      });

      history.push({ role: "assistant", name: LEADER_NAME, content: finalAnswer });
      syncAgentMemory(history, memoryState);

      send(ws, { type: "message", runId, id: finalMessageId, name: LEADER_NAME, content: finalAnswer });
      send(ws, { type: "final", runId, content: finalAnswer });
      send(ws, { type: "status", message: "Conversation finished.", runId });
      return;
    }

    history.push({ role: "assistant", name: nextSpeaker.name, content: reply });
    syncAgentMemory(history, memoryState);
    send(ws, { type: "message", runId, id: messageId, name: nextSpeaker.name, content: reply });
    await maybeUpdateMemorySummary(history, memoryState, turn, ws, runId);

    callCount += 1;
  }

  send(ws, {
    type: "status",
    message: "Max turns reached. Finalizing best-effort output...",
    runId,
  });
  const finalMessageId = `${runId}:final`;
  send(ws, { type: "message_start", runId, id: finalMessageId, name: LEADER_NAME });
  const finalAnswer = await generateFinalAnswer(finalPrompt, history, {
    ws,
    runId,
    messageId: finalMessageId,
  });
  history.push({ role: "assistant", name: LEADER_NAME, content: finalAnswer });
  syncAgentMemory(history, memoryState);
  send(ws, { type: "message", runId, id: finalMessageId, name: LEADER_NAME, content: finalAnswer });
  send(ws, { type: "final", runId, content: finalAnswer });
  send(ws, {
    type: "status",
    message: "Conversation ended by max turn limit.",
    runId,
  });
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
