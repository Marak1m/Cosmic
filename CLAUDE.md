# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

This is a research workspace. The **canonical architecture lives in the AutoGen notebooks under `notebooks/tasks/`** — those are how the agents are actually intended to be run. `notebooks/tasks/task-healthcare.ipynb` is the reference implementation for the `MemoryAgent` + custom speaker-selection + `Result_Provider` pattern that defines the COSMIC setup.

`apps/cosmic-agents-web/` is a Node port of that same idea, intended as a deployable web demo. **Status: currently non-functional — the last Railway build failed.** Treat it as a work-in-progress port; when in doubt about intended behavior, cross-reference the notebooks, not the server code.

- `notebooks/tasks/` — the canonical runs (healthcare, mathematics, bandwidth, resource allocation, robot warehouse, translation, story, scaling, researcher, business). Each uses the same `MemoryAgent` + custom speaker selection template, specialized per task.
- `notebooks/autogen modified/` vs `notebooks/autogen default/` — side-by-side comparison of the modified AutoGen setup vs. stock AutoGen baseline on matching tasks.
- `apps/cosmic-agents-web/` — Node/Express + WebSocket port of the notebook architecture. Self-contained; has its own `.env`, `package.json`, `README.md`.
- `scripts/` — one-off Python scripts. `termination_sensitivity_sweep.py` runs AutoGen GroupChat parameter sweeps; `patch_notebooks_add_repo_root.py`, `make_autogen_default.py`, `redact_secrets.py` are codebase maintenance helpers.
- `python/experiments/` — ad-hoc single-file Python experiments (not a package).
- `python/legacy/` — retired top-level Python files; do not edit unless asked.
- `tools/search_tools.py` and `Code/tools/search_tools.py` — duplicate Serper-based search wrappers used by notebooks/experiments.
- `Task Outputs/` — recorded outputs from notebook runs, grouped by task.
- `COSMIC_Leader-Driven_Context-Oriented_Collaboration_Between_Agents.pdf` — the paper that motivates the architecture. Read this first when the design intent isn't obvious from code.

Data and secrets: the root `.env.example` is only for Python scripts/notebooks. The web app has its own `apps/cosmic-agents-web/.env.example`. `data/` is gitignored (keep outputs out of commits).

## Web app: `apps/cosmic-agents-web/`

### Commands

Requires Node.js 20+ (`package.json` engines). The `.nvmrc` pins the version. There is no build step, no test suite, no linter — a code change is validated by running the server and exercising the demo in a browser.

```bash
cd apps/cosmic-agents-web
npm install
cp .env.example .env    # then set OPENAI_API_KEY (and optional SERPER_API_KEY)
npm start               # = node server.js
```

Endpoints: `/` (landing), `/demo` (demo UI), `/health` (JSON OK), `/ws` (WebSocket). Default port 3000 via `PORT`.

Deploy target is Railway (`railway.toml`, NIXPACKS, healthcheck `/health`).

### Architecture

Single-process Node server; all orchestration lives in `server.js` (~2.1k lines). The frontend in `public/` is static vanilla JS/CSS that talks to the server over the `/ws` WebSocket.

The run pipeline (`startConversation` → `runConversationCore`) is:

1. **Optimize** user prompt (`optimizeUserPrompt`, if `ENABLE_PROMPT_OPTIMIZER`).
2. **Clarify** — ask the user up to `MAX_CLARIFICATION_QUESTIONS` high-impact questions before running (`ENABLE_USER_CLARIFICATIONS`). This pauses the session in the `awaiting_clarifications` phase until the client sends a `clarify_response`.
3. **Plan** — `planAgents` asks the planner model for up to `MAX_AGENTS` (5) specialists + a Leader, returning JSON specs (name, role, focus, tools). Fallback plan if the planner fails.
4. **Speaker-selection loop** — up to `MAX_TURNS` (50) iterations of `selectNextSpeaker` → `generateAgentReply`. The loop ends when the Leader's reply ends with `TERMINATE`, or on max turns.
5. **Finalize** — `generateFinalAnswer` produces the user-facing output (streamed as the final Leader message).

Speaker selection logic (`selectNextSpeaker`):
- First turn: always the Leader.
- Every `LEADER_CHECKIN_INTERVAL` turns (default 10): forced Leader check-in.
- Fast-path: if the last message contains `Agent_X: ...` or `**Agent_X**: ...`, that agent speaks next — no extra model call.
- Otherwise, a cheap selector model call (see `SELECTOR_MODEL`) picks from eligible candidates.

Memory model (per run, in-process only):
- `history` is the full turn-by-turn transcript.
- `memoryState` holds a sliding window (`MEMORY_WINDOW = 50`) and an optional compressed `summary` that is regenerated periodically when `ENABLE_MEMORY_SUMMARY=true` (triggered by total char count ≥ `SUMMARY_TRIGGER_CHARS`, minimum `SUMMARY_MIN_TURNS_BETWEEN` turns between refreshes).
- Messages are passed through `trimMessagesToMaxChars` before every OpenAI call to stay under `MAX_INPUT_TOKENS × 4 chars/token`.

Model routing: distinct env vars select the model for each role (`PLANNER_MODEL`, `LEADER_MODEL`, `SELECTOR_MODEL`, `FINALIZER_MODEL`, `OPTIMIZER_MODEL`, `CLARIFIER_MODEL`, `SUMMARY_MODEL`, base `OPENAI_MODEL` for specialist agents). The OpenAI call helper (`callOpenAIChatRaw`) auto-adapts per model family — see `isO1Model` and `isGpt5FamilyModel`:
- o1 and gpt-5 family: no `temperature` sent; streaming is allowed but tool-calls go through non-streaming branch.
- `max_completion_tokens` vs. `max_tokens` preference is cached per model in `modelTokenParamPreference`.
- Tool-forcing (`tool_choice: "required"`) support cached in `modelToolForceSupported`; falls back to `"auto"` when the model rejects forcing.

Tool use: `searchWeb` (Serper) is the only external tool. It is only attached to agents that the planner/scorer picks as web-search candidates (`applyWebSearchAssignment`, max 2). Results are cached in-process (`SEARCH_CACHE_TTL_MS`, `SEARCH_CACHE_MAX_ENTRIES`). If `SERPER_API_KEY` is missing the server emits a status message and continues without browsing.

WebSocket protocol (server → client event `type`s): `status`, `agents`, `speaker`, `message_start`, `delta`, `message`, `final`, `clarify_request`, `error`. Client → server: `start` (with `prompt`), `clarify_response` (with `runId`, `answers`). Run state per socket is tracked in `wsSessions` (`phase`: `idle` / `awaiting_clarifications` / `starting` / running).

Per-role token caps (`PLANNER_MAX_OUTPUT_TOKENS`, `LEADER_MAX_OUTPUT_TOKENS`, `AGENT_MAX_OUTPUT_TOKENS`, `FINALIZER_MAX_OUTPUT_TOKENS`, `TOOL_CALL_MAX_TOKENS`, `SELECTOR_MAX_OUTPUT_TOKENS[_O1]`) are all clamped against `MAX_OUTPUT_TOKENS`. The full tunable list is in `.env.example`.

Termination: the Leader must end a message with the literal token `TERMINATE` — and that message is treated as the final answer's trigger, not the final answer itself (a separate `generateFinalAnswer` call produces the user-facing result). `ensureTerminateAtEnd` patches replies that mention termination without the correct suffix.

## Notebook architecture (the canonical design)

Reference notebook: [notebooks/tasks/task-healthcare.ipynb](notebooks/tasks/task-healthcare.ipynb). All other task notebooks follow the same shape with task-specific agents/prompts.

Core pieces:

- **`MemoryAgent(ConversableAgent)`** — subclass that overrides `receive` and `send` to append each non-tool-call message to a per-agent `self.memory = []` list. Tool-related messages (those with `tool_calls` / `tool` keys) are explicitly skipped. `generate_response` builds context as `[system_message] + self.memory[-10:] + messages` — i.e. each agent holds its own last-10-message window, separate from AutoGen's shared `GroupChat.messages`.
- **Fixed crew** — one `Leader` (MemoryAgent) + task specialists (MemoryAgents) + a `Result_Provider` (MemoryAgent, scripted to inject pre-written test results mid-run) + `Tool_executor` (plain `ConversableAgent` that only executes tools) + `user_proxy` (terminates on `TERMINATE`).
- **`allowed_speaker_transitions_dict`** — explicit adjacency map passed to `GroupChat` with `speaker_transitions_type="allowed"`. Convention: every agent can speak to every other agent *except* `Tool_executor`; only `user_proxy` is allowed to hand off to `Tool_executor`.
- **`custom_speaker_selection_func(last_speaker, groupchat)`** — the speaker selector. Pattern (see `cell-8` of the healthcare notebook):
  1. `is_first_call` flag → always return `Leader` on turn 0.
  2. `call_count == 5` → return `Result_Provider` (scripted mid-run data injection).
  3. `call_count % 7 == 0` → forced Leader check-in heartbeat.
  4. Otherwise → small LLM call (`query_ollama`) with a strict prompt ("ONLY RESPOND WITH THE NAME OF THE AGENT") to pick the next speaker from a hardcoded candidate list. Fallback: `None`.
- **Termination** — `is_termination_msg` returns True when `"TERMINATE"` appears in message content. Leader system prompts end with an instruction to say `TERMINATE` when done.
- **Post-run summarization** — `save_conversation_to_file(group_chat, "chat.txt")` dumps the full `groupchat.messages`, then `structure_logs_with_local_llm` feeds it to a separate Llama 3.1 model (via `ChatOpenAI` with an Ollama base URL) for a structured summary.
- **Models** — notebooks target **Ollama** (e.g. `qwen2.5:72b`) over a RunPod proxy, configured in `llm_config`. API keys and URLs are inlined in the notebooks (often blank on commit). This is *not* an OpenAI setup; don't port notebook changes to OpenAI assumptions.

When modifying or adding a task notebook, preserve this template: per-agent `MemoryAgent`, hardcoded scheduled agents at specific `call_count` values, explicit allowed-transitions dict, and a Leader-terminates contract.

### How the web app diverges from the notebook

The Node port in `apps/cosmic-agents-web/` does not yet faithfully reproduce the canonical design. Known deltas:

- Agents are *planned dynamically* by an LLM rather than being a fixed specialist crew.
- No per-agent memory object — memory is a single shared `history` + optional rolling summary, not the per-agent last-10-message window that `MemoryAgent` maintains.
- No `Result_Provider`-equivalent scripted mid-run injection.
- No `allowed_speaker_transitions_dict`; speaker selection is prompt-only.
- Uses OpenAI (o1 / gpt-5 family) instead of Ollama/qwen2.5.

When fixing the web app, the notebook is the spec — not the other way around.

## Python environment & notebooks

There is no single source of truth for Python deps; `requirements.txt` is a broad superset (AutoGen, CrewAI, LangChain, Chroma, etc., pinned to mid-2024 versions). Setup:

```bash
python -m venv .venv
.\.venv\Scripts\Activate.ps1   # PowerShell on Windows
pip install -r requirements.txt
```

Notebooks are not runnable standalone — `scripts/patch_notebooks_add_repo_root.py` inserts a `sys.path` bootstrap cell so they can import from `tools/` and the repo root. If you add a new notebook, run that script against it.

`scripts/termination_sensitivity_sweep.py` is a parameter-sweep harness around the same AutoGen GroupChat setup (heartbeat interval `T_LEADER`, consistency threshold `THETA_H`, stability thresholds `EPS_C`/`EPS_H`). Note its warning: o1 models only work on AutoGen's ChatCompletions path if `max_tokens` and non-default `temperature` are omitted — the script does this conditionally.

`tools/search_tools.py` contains a hard-coded Serper API key (legacy artifact). When modifying this file, prefer reading from `os.environ["SERPER_API_KEY"]` without overwriting it.

## Conventions specific to this repo

- Windows is the primary dev environment (paths, PowerShell commands in READMEs). Keep shell snippets cross-platform where practical, but don't rewrite existing PowerShell examples.
- The web app and the Python side are intentionally decoupled — do not introduce a cross-cutting dependency (e.g., don't add a Python import from `apps/`, and don't add a Node module that reads notebooks).
- `python/legacy/` and `notebooks/autogen default/` are frozen baselines kept for comparison. Do not "clean up" these files.
- Secrets live only in `.env` files (gitignored). Never commit keys, and be wary of `tools/search_tools.py` which historically contained an inline key.
