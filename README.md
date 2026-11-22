# LinkedIn Agent

A goal-driven LinkedIn agent. Give it a goal, it plans its own flow and executes **one action at a time**, checking its work as it goes.

- **LinkedIn API** — [Unipile](https://unipile.com) (`unipile-node-sdk`)
- **Reasoning** — [OpenRouter](https://openrouter.ai) free models
- **Runtime** — Node.js, no framework, 3 source files

## Files

| File | Role |
| --- | --- |
| `tools.js` | 14 LinkedIn tools — each a one-line wrapper over a prebuilt Unipile SDK call |
| `agent.js` | The loop: plan → one tool → result → next step → `finish` |
| `context.js` | Context management — reasoning stripping, eviction, compaction, memory |
| `server.js` | Tiny HTTP server, streams progress over SSE |
| `public/index.html` | Minimal UI (goal box + live step log) |

## Setup

```bash
npm install
cp .env.example .env   # then fill in your keys
npm start              # → http://localhost:3000
```

### 1. Unipile

1. Sign up at [dashboardv2.unipile.com](https://dashboardv2.unipile.com)
2. Create an **Application**, then an **API Key**
3. In **Accounts → Link Account**, authenticate your LinkedIn account
4. Put the API key in `.env` as `UNIPILE_API_KEY`

`UNIPILE_ACCOUNT_ID` can stay empty — the agent picks your first linked LinkedIn account automatically.

### 2. OpenRouter

1. Create a key at [openrouter.ai/keys](https://openrouter.ai/keys)
2. Put it in `.env` as `OPENROUTER_API_KEY`

The default model is `nvidia/nemotron-3-ultra-550b-a55b:free` — free, 1M context, built for agentic tool use. Any `:free` model with tool calling works; change it with `MODEL=`.

> Free models allow **~20 requests/min and 50/day**. A run typically costs 5–15 requests, so budget accordingly.

## How the agent behaves

**Plans first.** Its opening reply is a short numbered plan, followed immediately by the first tool call.

**One thing at a time.** Exactly one tool call runs per turn. Results are fed back before the next decision — no batching. If the model emits several calls, only the first runs and the rest are deferred a turn.

**Reads before it writes.** Read tools (`search_people`, `get_profile`, `list_chats`, …) are always safe and used freely to establish facts. Write tools (`send_message`, `create_post`, …) only fire once a target is confirmed from a real result.

**Verifies after it writes.** Any successful write gets a harness nudge requiring a read-back confirmation before the next step — so a sent message is checked in the thread before the agent moves on.

**Treats errors as data.** Unipile/LinkedIn failures come back as tool output, not crashes. The model corrects its input or changes route instead of repeating the call.

Nothing is hard-blocked and nothing waits for human approval — the flow is decided by the model, and you can hit **Stop** at any time.

## Context management

`context.js` keeps the transcript from bloating, in four layers:

1. **Reasoning is stripped.** A reasoning model's chain-of-thought is shown in the UI but never stored in history — it's the largest source of dead tokens.
2. **Stale results are evicted.** Tool results older than `KEEP_TURNS` collapse to a stub that keeps every id (`acc_…`, `ACo…`, `2-…`) but drops the payload.
3. **Rolling compaction.** When the transcript passes `COMPACT_AT` tokens, older turns are summarised into one note and dropped. The split point is chosen so an assistant/tool pair is never torn apart (that would break the API request). Costs one extra model call, only when actually needed.
4. **Cross-run memory.** Finished runs append to `.memory.jsonl`. The next run loads the last few and is told what was already done, so it won't re-message someone or repeat a post.

With the defaults, a 20-step run stays around 35K tokens — well inside a free model's window. Compaction is a safety net for when you raise `MAX_STEPS`.

## Environment

```env
UNIPILE_API_KEY=          # required
OPENROUTER_API_KEY=       # required
UNIPILE_ACCOUNT_ID=       # optional — auto-detected
MODEL=nvidia/nemotron-3-ultra-550b-a55b:free
MAX_STEPS=20
PORT=3000
UNIPILE_BASE_URL=https://api.unipile.com   # optional

# Context tuning (rarely needed)
KEEP_TURNS=4           # tool results kept verbatim before eviction
KEEP_RECENT=6          # messages compaction never touches
COMPACT_AT=60000       # tokens before rolling compaction fires
```

## Usage

Open `http://localhost:3000`, type a goal, press **Run**:

```
Find 5 fintech founders in Mumbai and message each a short intro.
```
```
Check my recent messages and reply to anyone waiting on me.
```
```
Write a post about shipping a side project, then like my last 3 posts.
```

`Cmd/Ctrl + Enter` runs the goal from the textarea.
