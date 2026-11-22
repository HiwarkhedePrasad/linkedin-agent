import OpenAI from 'openai';
import { TOOLS, runTool, WRITES } from './tools.js';
import {
  keepAssistant,
  track,
  evict,
  maybeCompact,
  loadMemory,
  saveMemory,
  memoryBlock,
} from './context.js';

const MODEL = process.env.MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';
const MAX_STEPS = Number(process.env.MAX_STEPS) || 20;

/** Built on first use so a missing key is a clear run error, not a boot crash. */
let client;
function llm() {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set — add it to .env');
  if (!client) {
    client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
      defaultHeaders: { 'HTTP-Referer': 'http://localhost', 'X-Title': 'LinkedIn Agent' },
    });
  }
  return client;
}

const SYSTEM = `You are an autonomous LinkedIn agent driving a real LinkedIn account through the Unipile API. Work like an engineer at a terminal: investigate first, act once, confirm the result.

You are given exactly ONE goal. You decide the plan and the order yourself. Do not ask clarifying questions — make reasonable assumptions and proceed.

How you work:
1. Your FIRST reply must be a short numbered plan (max 6 steps), then immediately call the FIRST tool of that plan.
2. Call exactly ONE tool per reply. Never batch actions.
3. Investigate before you act. Search and read until the target is unambiguous. Tool results are your only source of ids, names and facts — never invent an identifier.
4. After any write action, confirm it actually happened with a read tool before moving on.
5. Errors are information, not failures. Read them, correct your input or change approach — never repeat a failing call unchanged.
6. When the goal is achieved, call finish. If it cannot be done, call finish with status "blocked" and explain what stopped you.

Tool classes:
- Read (always safe, use freely): search_people, get_profile, get_my_profile, list_connections, list_chats, get_messages, list_posts
- Write (changes a live account): send_message, start_chat, send_connection_request, create_post, comment_on_post, react_to_post

Written text must be natural, specific, short, and in the same language as the goal.`;

export async function runAgent(goal, emit) {
  const missing = ['OPENROUTER_API_KEY', 'UNIPILE_API_KEY'].filter((k) => !process.env[k]);
  if (missing.length) {
    emit({ type: 'error', text: `Missing ${missing.join(' and ')} — copy .env.example to .env and fill it in.` });
    return { status: 'error' };
  }

  // Layer 4 — what earlier runs already did.
  const messages = [
    { role: 'system', content: SYSTEM + memoryBlock(await loadMemory()) },
    { role: 'user', content: `GOAL: ${goal}` },
  ];
  const meta = new Map(); // layer 2 — ids behind each tool result
  const acted = []; //       layer 4 — writes to record

  // Used only by compaction; the main loop calls create() directly.
  const complete = async (msgs) => {
    const r = await llm().chat.completions.create({ model: MODEL, messages: msgs });
    return r.choices?.[0]?.message?.content || '';
  };

  const persist = (status, summary) =>
    saveMemory({ ts: Date.now(), goal, status, summary, acted });

  for (let step = 1; step <= MAX_STEPS; step++) {
    emit({ type: 'step', n: step });

    // Layers 2 and 3 — keep the transcript flat before paying to send it.
    evict(meta, messages);
    await maybeCompact(messages, meta, complete, emit);

    let res;
    try {
      res = await llm().chat.completions.create({ model: MODEL, messages, tools: TOOLS, tool_choice: 'auto' });
    } catch (err) {
      const hint =
        err?.status === 429
          ? 'OpenRouter rate limit hit — free models allow ~20 req/min and 50 req/day. Wait and retry.'
          : 'Model request failed.';
      emit({ type: 'error', text: `${hint} (${err?.message || err})` });
      if (acted.length) await persist('error', 'Run interrupted after partial progress.');
      return { status: 'error' };
    }

    const msg = res.choices?.[0]?.message;
    if (!msg) {
      emit({ type: 'error', text: 'Model returned no message.' });
      return { status: 'error' };
    }

    // Layer 1 — reasoning is read for display, never stored.
    messages.push(keepAssistant(msg));

    const thought = msg.content || msg.reasoning || '';
    if (thought) emit({ type: 'thought', text: thought });

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      emit({ type: 'nudge' });
      messages.push({ role: 'user', content: 'Continue. Call exactly one next tool, or call finish if the goal is complete.' });
      continue;
    }

    // One action at a time: only the first call runs.
    const [first, ...rest] = calls;
    let name, args;
    try {
      name = first.function.name;
      args = JSON.parse(first.function.arguments || '{}');
    } catch {
      emit({ type: 'error', text: 'Model produced malformed tool arguments.' });
      return { status: 'error' };
    }

    if (name === 'finish') {
      await persist(args.status, args.summary);
      emit({ type: 'done', status: args.status, summary: args.summary });
      return { status: args.status, summary: args.summary };
    }

    emit({ type: 'action', tool: name, args });
    const { ok, content } = await runTool(name, first.function.arguments);
    emit({ type: 'result', tool: name, output: content });

    if (ok && WRITES.has(name)) acted.push({ tool: name, args });

    const toolMsg = {
      role: 'tool',
      tool_call_id: first.id,
      // Harness nudge: a successful write earns a mandatory verification read next turn.
      content:
        ok && WRITES.has(name)
          ? `${content}\n\n[system] ${name} succeeded. Before your next step, confirm the effect with a read tool and report what you find.`
          : content,
    };
    messages.push(toolMsg);
    track(meta, toolMsg, name, content); // ids captured from the original payload

    // Answer any extra calls so the API stays valid, but defer them a turn.
    for (const extra of rest) {
      const deferred = {
        role: 'tool',
        tool_call_id: extra.id,
        content: JSON.stringify({ deferred: 'Exactly one action per turn — call this one next turn.' }),
      };
      messages.push(deferred);
      track(meta, deferred, 'deferred', '');
    }
  }

  emit({ type: 'error', text: `Stopped at the ${MAX_STEPS}-step limit before the goal was finished.` });
  await persist('limit', 'Step limit reached before completion.');
  return { status: 'limit' };
}
