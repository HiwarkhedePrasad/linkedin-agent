import { UnipileClient } from 'unipile-node-sdk';

const BASE_URL = process.env.UNIPILE_BASE_URL || 'https://api.unipile.com';
const client = new UnipileClient(BASE_URL, process.env.UNIPILE_API_KEY);

/** Resolve (and cache) the LinkedIn account id. */
let cachedAccount;
export async function accountId() {
  if (process.env.UNIPILE_ACCOUNT_ID) return process.env.UNIPILE_ACCOUNT_ID;
  if (cachedAccount) return cachedAccount;
  const res = await client.account.getAll();
  const items = res?.items ?? [];
  const linkedin = items.find((a) => String(a?.type).toUpperCase() === 'LINKEDIN') || items[0];
  if (!linkedin) {
    throw new Error('No account linked in Unipile. Link a LinkedIn account in the Unipile dashboard first.');
  }
  cachedAccount = linkedin.id;
  return cachedAccount;
}

/** Keep tool output small enough for a free model's context. */
const clip = (value, max = 6000) => {
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s;
};

/** Every handler is a one-liner over a prebuilt Unipile SDK call. */
const handlers = {
  search_people: async ({ keywords, limit = 10 }) =>
    client.request.send({
      method: 'POST',
      path: ['linkedin', 'search'],
      parameters: { account_id: await accountId(), limit: String(Math.min(Number(limit) || 10, 25)) },
      body: { api: 'classic', category: 'people', keywords },
      headers: { 'Content-Type': 'application/json' },
    }),

  get_profile: ({ identifier }) =>
    client.users.getProfile({ account_id: accountId(), identifier }),

  get_my_profile: () => client.users.getOwnProfile(accountId()),

  list_connections: ({ limit = 25 }) =>
    client.users.getAllRelations({ account_id: accountId(), limit: Number(limit) || 25 }),

  list_chats: ({ limit = 25 }) =>
    client.messaging.getAllChats({ account_id: accountId(), limit: Number(limit) || 25 }),

  get_messages: ({ chat_id, limit = 30 }) =>
    client.messaging.getAllMessagesFromChat({ chat_id, limit: Number(limit) || 30 }),

  send_message: ({ chat_id, text }) => client.messaging.sendMessage({ chat_id, text }),

  start_chat: ({ profile_id, text }) =>
    client.messaging.startNewChat({
      account_id: accountId(),
      attendees_ids: [profile_id],
      text,
      options: { linkedin: { api: 'classic' } },
    }),

  send_connection_request: ({ provider_id, message }) =>
    client.users.sendInvitation({ account_id: accountId(), provider_id, ...(message && { message }) }),

  list_posts: ({ identifier, limit = 10 }) =>
    client.users.getAllPosts({ account_id: accountId(), identifier, limit: Number(limit) || 10 }),

  create_post: ({ text }) => client.users.createPost({ account_id: accountId(), text }),

  comment_on_post: ({ post_id, text }) =>
    client.users.sendPostComment({ account_id: accountId(), post_id, text }),

  react_to_post: ({ post_id, reaction_type }) =>
    client.users.sendPostReaction({
      account_id: accountId(),
      post_id,
      ...(reaction_type && { reaction_type }),
    }),
};

/** OpenAI-compatible tool definitions handed to the model. */
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_people',
      description: 'Search LinkedIn people by keywords. Use this to find someone and get their provider id before acting on them.',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'string', description: 'Plain text search, e.g. "founder Bangalore" or a full name.' },
          limit: { type: 'integer', description: 'Max results, 1-25. Default 10.' },
        },
        required: ['keywords'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_profile',
      description: 'Fetch one LinkedIn profile in detail (headline, experience, education). Identifier = public vanity URL or provider id from search_people.',
      parameters: {
        type: 'object',
        properties: { identifier: { type: 'string' } },
        required: ['identifier'],
      },
    },
  },
  {
    type: 'function',
    function: { name: 'get_my_profile', description: "The linked account owner's own profile.", parameters: { type: 'object', properties: {} } },
  },
  {
    type: 'function',
    function: {
      name: 'list_connections',
      description: "List the account's 1st-degree connections.",
      parameters: { type: 'object', properties: { limit: { type: 'integer' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_chats',
      description: 'List message threads (most recent first). Gives chat_id values needed by get_messages and send_message.',
      parameters: { type: 'object', properties: { limit: { type: 'integer' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_messages',
      description: 'Read the messages of one chat thread.',
      parameters: {
        type: 'object',
        properties: { chat_id: { type: 'string' }, limit: { type: 'integer' } },
        required: ['chat_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Send a message into an existing chat thread. Irreversible — only when the goal requires it.',
      parameters: {
        type: 'object',
        properties: { chat_id: { type: 'string' }, text: { type: 'string' } },
        required: ['chat_id', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_chat',
      description: 'Open a brand new conversation with a profile_id (from search_people). Irreversible — only when the goal requires it.',
      parameters: {
        type: 'object',
        properties: { profile_id: { type: 'string' }, text: { type: 'string' } },
        required: ['profile_id', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_connection_request',
      description: 'Send a connection invitation to a provider_id (from search_people). Optional note, max 300 chars. Irreversible.',
      parameters: {
        type: 'object',
        properties: { provider_id: { type: 'string' }, message: { type: 'string', maxLength: 300 } },
        required: ['provider_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_posts',
      description: "List posts written by a person or company (identifier = vanity URL, provider id, or company id).",
      parameters: {
        type: 'object',
        properties: { identifier: { type: 'string' }, limit: { type: 'integer' } },
        required: ['identifier'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_post',
      description: 'Publish a post from the linked account. Irreversible — only when the goal requires it.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'comment_on_post',
      description: 'Comment on a post. Irreversible — only when the goal requires it.',
      parameters: {
        type: 'object',
        properties: { post_id: { type: 'string' }, text: { type: 'string' } },
        required: ['post_id', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'react_to_post',
      description: 'Like/react to a post. Irreversible — only when the goal requires it.',
      parameters: {
        type: 'object',
        properties: {
          post_id: { type: 'string' },
          reaction_type: { type: 'string', enum: ['like', 'celebrate', 'support', 'love', 'insightful', 'funny'] },
        },
        required: ['post_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Declare the goal complete (or blocked). Always call this exactly once when done — never call it with another tool.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['complete', 'blocked'] },
          summary: { type: 'string', description: 'What was done, in 1-3 sentences.' },
        },
        required: ['status', 'summary'],
      },
    },
  },
];

/** Tools that change the live account. */
export const WRITES = new Set([
  'send_message',
  'start_chat',
  'send_connection_request',
  'create_post',
  'comment_on_post',
  'react_to_post',
]);

/**
 * Execute one tool call. Returns { ok, content }.
 * Failures come back as data, never as exceptions — the model reads them and adapts.
 */
export async function runTool(name, argsJson) {
  const handler = handlers[name];
  if (!handler) return { ok: false, content: clip({ error: `Unknown tool: ${name}` }) };

  let args = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return { ok: false, content: clip({ error: 'Arguments were not valid JSON.' }) };
  }

  try {
    return { ok: true, content: clip(await handler(args)) };
  } catch (err) {
    return {
      ok: false,
      content: clip({
        error: err?.message || String(err),
        type: err?.type || err?.name,
        status: err?.status || err?.response?.status,
      }),
    };
  }
}
