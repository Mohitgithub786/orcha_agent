# Orcha Agent 🤖⚡️

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5.x-black.svg)](https://fastify.dev/)
[![LangGraph](https://img.shields.io/badge/LangGraph-State_Orchestrator-6366f1.svg)](https://langchain-ai.github.io/langgraphjs/)
[![Security: AES-256](https://img.shields.io/badge/Security-AES--256--CBC-10b981.svg)](https://nodejs.org/api/crypto.html)

**Orcha Agent** is an autonomous AI agent orchestration platform built with **TypeScript**, **Fastify**, and **LangGraph**. It enables dynamic, self-healing LLM agents that interface with internal tools, notify users across Telegram/SMTP, execute sandboxed code, and securely manage credentials on the fly.

---

## 🌟 Key Capabilities

* **⚡️ High-Performance Fastify Engine**: Lightning-fast REST & API endpoints with built-in static asset serving for the web interface.
* **🧠 Multi-Step LangGraph Workflows**: Cyclical state graph execution with checkpointer memory persistence to maintain long-term context across multi-turn reasoning loops.
* **🔐 Self-Healing Credential Vault**: Integrated AES-256-CBC encrypted vault. When agents encounter missing secrets (e.g. Telegram tokens, SMTP passwords), they proactively prompt the user and securely store them in the database via the `store_credential` tool.
* **💻 Isolated Code Execution Sandbox**: Built-in memory-capped JavaScript sandbox engine preloaded with `lodash` and `dayjs` for safe code evaluation and data wrangling.
* **🎨 Interactive Visual Dashboard**: Modern cyberpunk/glassmorphism UI featuring:
  * Real-time LangGraph pipeline stepper (`Input` → `Graph` → `Tool Call` → `Vault Sync` → `Output`)
  * Agent Studio to tune models (Groq, OpenAI, Claude, Gemini) and system prompts
  * Visual Tool Registry & live execution testing
  * Telemetry metrics and execution trace JSON exporter

---

## 🛠️ Modular Tool Registry

| Tool | Category | Description |
|---|---|---|
| 🌍 `web_search` | Intelligence | Real-time internet search via Serper API |
| 📱 `telegram_notify` | Notification | Dispatches push alerts to Telegram channels/chats |
| 📨 `send_email` | Dispatch | Authenticated HTML/text email dispatch via SMTP relay |
| 🗝️ `store_credential` | Vault | Proactively collects & encrypts missing credentials |
| 💻 `code_sandbox` | Execution | Runs sandboxed JS in an isolated Node.js context |

---

## 🚀 Quick Start

### 1. Clone & Install
```bash
git clone https://github.com/Mohitgithub786/orcha_agent.git
cd orcha_agent
npm install --legacy-peer-deps
```

### 2. Configure Environment
Copy `.env.example` to `.env`:
```env
DATABASE_URL="postgresql://[user]:[password]@[host]:5432/[db]"

# LLM & Search
GROQ_API_KEY="your_groq_api_key"
SERPER_API_KEY="your_serper_api_key"

# 32-byte encryption key for credential vault
ENCRYPTION_KEY="your_32_byte_hex_string"

PORT=3001
NODE_ENV="development"
```

### 3. Run Locally
```bash
npm run dev
```

Open your browser at:
👉 **`http://localhost:3001`**

---

## 🏗️ Architecture

```
orcha_agent/
├── public/                 # Futuristic Glassmorphism Frontend Dashboard
│   ├── index.html          # Control center, Studio, Vault, & Telemetry
│   ├── style.css           # Modern Cyberpunk theme & animations
│   └── app.js              # State graph visualizer, canvas & live chat
├── src/
│   ├── db/                 # Drizzle schemas (PostgreSQL / Supabase)
│   ├── executors/          # Tool executors (HTTP, Platform, Sandbox VM)
│   ├── registry/           # Platform tools & dynamic database seeder
│   ├── routes/             # Fastify REST endpoints (/run, /agents, /tools, /vault)
│   ├── runner.ts           # Central LangGraph execution engine
│   ├── vault.ts            # AES-256-CBC encryption & key recovery logic
│   └── server.ts           # Fastify server entry point
└── drizzle.config.ts
```

---

## 📜 License
MIT © [Mohitgithub786](https://github.com/Mohitgithub786)
