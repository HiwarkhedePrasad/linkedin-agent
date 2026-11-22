import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Context management for the agent loop — four layers:
 *   1. strip reasoning out of history
 *   2. evict stale tool results (free, no LLM call)
 *   3. roll up older turns into a summary when the transcript grows (costs 1 call)
 *   4. persist finished goals so a later run doesn't redo them
 */

const KEEP_TURNS = Number(process.env.KEEP_TURNS) || 4; // tool results kept verbatim
const KEEP_RECENT = Number(process.env.KEEP_RECENT) || 6; // messages compaction never touches
const COMPACT_AT = Number(process.env.COMPACT_AT) || 60000; // tokens before compacting
const MEMORY_LIMIT = 10;

const MEMORY_FILE = path.resolve(process.cwd(), '.memory.jsonl');

/* ------------------------------------------------------------------ layer 1 */

/** Drop reasoning fields before an assistant message enters history. */
export const keepAssistant = ({ reasoning, reasoning_details, ...rest }) => rest;

/* ------------------------------------------------------------------ layer 2 */

// Unipile account ids, LinkedIn member ids, URNs, company ids, chat thread ids.
// No \b anchors: LinkedIn ids are underscore-terminated and _ is a word character,
// so a trailing \b made the whole alternative fail to match.
const IDS = /(?:acc_[A-Za-z0-9_]+|ACo[A-Za-z0-9_]+|ADo[A-Za-z0-9_]+|urn:li:[\w:.-]+|\d{9,}|2-[A-Za-z0-9+/=_-]{12,})/g;

const extractIds = (s) => [...new Set(s.match(IDS) || [])].slice(0, 25).join(' ');

/** Remember the ids a tool result contained, without keeping the payload. */
export function track(meta, message, tool, content) {
  meta.set(message, { tool, ids: extractIds(content), evicted: false });
}

/** Collapse tool results older than KEEP_TURNS down to just their ids. */
export function evict(meta, messages) {
  const results = messages.filter((m) => m.role === 'tool');
  for (const m of results.slice(0, Math.max(0, results.length - KEEP_TURNS))) {
    const info = meta.get(m);
    if (!info || info.evicted) continue;
    m.content = `[evicted earlier ${info.tool} result — ids remain available]\n${info.ids || 'no ids'}`;
    info.evicted = true;
  }
}

/* ------------------------------------------------------------------ layer 3 */

const estimate = (messages) => Math.ceil(JSON.stringify(messages).length / 4);

const fmt = (m) => {
  if (m.role === 'tool') return `TOOL RESULT: ${m.content}`;
  if (m.role === 'assistant') {
    const calls = (m.tool_calls || [])
      .map((t) => `\n  CALL ${t.function.name}(${t.function.arguments})`)
      .join('');
    return `ASSISTANT: ${m.content || ''}${calls}`;
  }
  return `${m.role.toUpperCase()}: ${m.content}`;
};

/**
 * When the transcript passes COMPACT_AT, summarise the older turns and drop them.
 * The split point is chosen so no assistant/tool pair is ever torn apart —
 * otherwise the API rejects the request for an unanswered tool_call.
 */
export async function maybeCompact(messages, meta, complete, emit) {
  if (estimate(messages) < COMPACT_AT) return false;

  let split = -1;
  for (let i = messages.length - 2; i >= 2; i--) {
    const a = messages[i];
    const b = messages[i + 1];
    const safe =
      (a.role === 'assistant' && a.tool_calls?.length && b?.role === 'tool') ||
      a.role === 'user' ||
      a.role === 'system';
    if (safe && i - 2 >= 2 && messages.length - i >= 2) {
      split = i;
      break;
    }
  }
  if (split < 0) return false;

  const middle = messages.slice(2, split);
  const recent = messages.slice(split);
  const transcript = middle.map(fmt).join('\n');
  if (transcript.length < 2000) return false; // not worth a request

  const note = await complete([
    {
      role: 'system',
      content:
        'Compress this agent transcript into a dense factual note for the same agent to continue from. ' +
        'Preserve every id, name, decision, outcome and unresolved thread verbatim. ' +
        'No preamble, no advice, max 400 words.',
    },
    { role: 'user', content: transcript },
  ]);
  if (!note) return false;

  messages.splice(
    0,
    messages.length,
    messages[0], // system prompt
    messages[1], // original goal
    { role: 'system', content: `[Earlier work, compacted]\n${note}` },
    ...recent,
  );
  for (const m of middle) meta.delete(m);

  emit({ type: 'compact', dropped: middle.length, kept: recent.length });
  return true;
}

/* ------------------------------------------------------------------ layer 4 */

export async function loadMemory() {
  try {
    const raw = await readFile(MEMORY_FILE, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .slice(-MEMORY_LIMIT)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export async function saveMemory(entry) {
  try {
    await appendFile(MEMORY_FILE, JSON.stringify(entry) + '\n');
  } catch {
    // memory is best-effort; never fail a run over it
  }
}

/** Render past runs into a bounded block for the system prompt. */
export function memoryBlock(entries) {
  if (!entries.length) return '';

  const render = (e) => {
    const acts = (e.acted || [])
      .map((a) => `${a.tool}(${Object.entries(a.args).map(([k, v]) => `${k}=${v}`).join(', ')})`)
      .join('; ');
    return `- "${e.goal}" → ${e.status}. ${e.summary || ''}${acts ? ` Already done: ${acts}.` : ''}`;
  };

  // Newest first, add lines until the budget runs out — never cut one in half,
  // or an id gets sliced and the agent loses it.
  const BUDGET = 3500;
  const chosen = [];
  let used = 0;
  for (const e of [...entries].reverse().slice(0, 8)) {
    const line = render(e);
    if (used + line.length > BUDGET) break;
    chosen.push(line);
    used += line.length;
  }
  if (!chosen.length) return '';

  chosen.reverse();
  return `\n\nPrevious runs — never repeat an action already listed:\n${chosen.join('\n')}`;
}
