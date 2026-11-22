import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Maps an anonymous browser id (the `name` sent to Unipile's hosted auth) to
 * the linked account_id. AsyncLocalStorage makes that account id available to
 * every tool call in the current request without passing it through 13 tools.
 */

const FILE = path.resolve(process.cwd(), '.accounts.json');
const COOKIE = 'la_uid';
const storage = new AsyncLocalStorage();

let accounts = {};
try {
  accounts = JSON.parse(await readFile(FILE, 'utf8'));
} catch {
  // first run
}

const persist = () => writeFile(FILE, JSON.stringify(accounts, null, 2)).catch(() => {});

export const runWithUser = (uid, fn) => storage.run({ uid }, fn);
export const accountFor = (uid) => accounts[uid] || null;
export const currentUid = () => storage.getStore()?.uid;

export function setAccount(uid, accountId) {
  if (!uid || !accountId) return;
  accounts[uid] = accountId;
  persist();
}

/** Read the anonymous id from the cookie, creating one on first visit. */
export function ensureUid(req, res) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f-]{36})`));
  if (match) return match[1];

  const uid = randomUUID();
  res.setHeader('Set-Cookie', `${COOKIE}=${uid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  return uid;
}

/** The notify_url carries a shared secret so random POSTs can't register accounts. */
export const notifySecret = () => process.env.NOTIFY_SECRET || 'dev-notify-secret';
export const validNotify = (token) => Boolean(token) && token === notifySecret();
