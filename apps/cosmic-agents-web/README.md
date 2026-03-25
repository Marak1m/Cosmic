# Cosmic Agents Web

This app is a Node/Express + WebSocket demo that runs governed multi-agent workflows on the OpenAI API:

- Plans up to five task-specific specialists + a Leader
- Runs a custom Speaker Selector loop
- Uses shared/bounded memory (with optional periodic summarization)
- Supports optional prompt optimization + pre-run user clarifications
- Streams the live dialogue to the browser

## Setup

Requires Node.js 16+ (18+ recommended).

```powershell
cd apps/cosmic-agents-web
npm install
copy .env.example .env
```

Edit `.env` and set:

- `OPENAI_API_KEY=...`
- (optional) `SERPER_API_KEY=...` (enables web search)

## Run locally

```powershell
cd apps/cosmic-agents-web
npm start
```

Open:

- Landing page: `http://localhost:<PORT>/`
- Demo: `http://localhost:<PORT>/demo`

## Notes

- Default models are set in `.env.example` (`OPENAI_MODEL`, `PLANNER_MODEL`, `LEADER_MODEL`, `SELECTOR_MODEL`, `FINALIZER_MODEL`).
- `ENABLE_PROMPT_OPTIMIZER=true` rewrites the user prompt before planning.
- `ENABLE_USER_CLARIFICATIONS=true` asks high-impact questions before running the crew (only if needed).
- `ENABLE_STREAMING=true` streams partial message deltas for faster perceived latency.
- `ENABLE_MEMORY_SUMMARY=true` periodically compresses long chats into a compact "shared memory summary" to keep later turns faster.
- The run ends only when the Leader ends a message with `TERMINATE` (same message as the final answer), or after max turns.

## Deploy

Set the same environment variables on your host and run `node server.js` (or `npm start`).
The frontend is served from `public/` and the WebSocket endpoint is `/ws`.

