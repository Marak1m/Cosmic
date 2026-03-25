# Cosmic Agents — LLM Agent Experiments + Web Demo

This repo is a research/code workspace for building and testing multi-agent LLM systems (Leader + specialist agents, custom speaker selection, shared memory, optional web search tools), plus a deployable web demo.

## What’s in here

- `apps/cosmic-agents-web/` - Node/Express + WebSocket web app that plans a crew, runs a speaker-selection loop, and streams the live dialogue
- `rag_pdf/` - Python RAG-on-PDF prototype (kept at repo root for minimal disruption)
- `notebooks/` - task notebooks and AutoGen variants (`notebooks/tasks/`, `notebooks/autogen modified/`, `notebooks/autogen default/`, `notebooks/misc/`)
- `python/` - Python experiments and utilities (non-RAG)
- `scripts/` - small helper scripts
- `data/` - local artifacts/outputs (ignored by git; see `data/README.md`)

## Quick start (web demo)

### Prerequisites

- Node.js 16+ (18+ recommended)

### Setup

```powershell
cd apps/cosmic-agents-web
npm install
copy .env.example .env
```

Edit `apps/cosmic-agents-web/.env` and set at least:

- `OPENAI_API_KEY=...`
- (optional) `SERPER_API_KEY=...` (enables web search)

### Run

```powershell
cd apps/cosmic-agents-web
npm start
```

Open:

- Landing page: `http://localhost:<PORT>/`
- Demo: `http://localhost:<PORT>/demo`

See `apps/cosmic-agents-web/README.md` for configuration knobs (models, token budgets, streaming, memory summaries, clarifications).

## Python setup (notebooks / experiments)

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Run notebooks via Jupyter/VS Code.

## Configuration

- Root `.env.example` is used by some Python scripts; the web app has its own `apps/cosmic-agents-web/.env.example`.
- Do not commit secrets: `.env` files are ignored.
