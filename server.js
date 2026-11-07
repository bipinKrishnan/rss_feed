import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseFeed, discoverFeed, hostOf } from './lib/feed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';
const PID_FILE = path.join(DATA_DIR, `server-${PORT}.pid`);

const DEFAULT_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0 Safari/537.36 PersonalRSS/1.0',
  accept:
    'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, ' +
    'text/xml;q=0.9, text/html;q=0.8, */*;q=0.6',
  'accept-language': 'en-US,en;q=0.8',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

/** @type {{feeds: any[], items: Record<string, any[]>, read: Record<string, 1>, starred: Record<string, 1>, meta: any}} */
const store = { feeds: [], items: {}, read: {}, starred: {}, meta: {} };

/** item id -> { feedId, item } */
const index = new Map();
let saveTimer = null;

function rebuildIndex() {
  index.clear();
  for (const feed of store.feeds) {
    const list = store.items[feed.id] || [];
    for (const item of list) index.set(item.id, { feedId: feed.id, item });
  }
}

async function loadStore() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fsp.readFile(STORE_FILE, 'utf8');
    const data = JSON.parse(raw);
    store.feeds = Array.isArray(data.feeds) ? data.feeds : [];
    store.items = data.items && typeof data.items === 'object' ? data.items : {};
    store.read = data.read && typeof data.read === 'object' ? data.read : {};
    store.starred = data.starred && typeof data.starred === 'object' ? data.starred : {};
    store.meta = data.meta && typeof data.meta === 'object' ? data.meta : {};
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[rss] could not read store:', err.message);
  }
  rebuildIndex();
}

function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const tmp = `${STORE_FILE}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(store), 'utf8');
      await fsp.rename(tmp, STORE_FILE);
    } catch (err) {
      console.error('[rss] failed to save store:', err.message);
    }
  }, 200);
}

// ---------------------------------------------------------------------------
// feed fetching
// ---------------------------------------------------------------------------

class FetchError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function fetchDocument(url, extraHeaders = {}) {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: { ...DEFAULT_HEADERS, ...extraHeaders },
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? 'Request timed out' : (err?.cause?.code || err.message);
    throw new FetchError(`Could not reach the server (${reason})`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || '';
  let text = buf.toString('utf8');

  const charset = (/charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] || '').toLowerCase();
  if (charset && !/^utf-?8$/.test(charset)) {
    try { text = new TextDecoder(charset).decode(buf); } catch { /* keep utf8 */ }
  } else if (!charset) {
    const decl = /<\?xml[^>]+encoding\s*=\s*["']([^"']+)["']/i.exec(text.slice(0, 300));
    if (decl && !/^utf-?8$/i.test(decl[1])) {
      try { text = new TextDecoder(decl[1]).decode(buf); } catch { /* keep utf8 */ }
    }
  }

  return {
    status: res.status,
    ok: res.ok,
    url: res.url || url,
    contentType,
    headers: res.headers,
    text,
  };
}

function looksLikeHtml(doc) {
  const ct = (doc.contentType || '').toLowerCase();
  if (ct.includes('html')) return true;
  if (ct.includes('xml') || ct.includes('rss') || ct.includes('atom') || ct.includes('json')) return false;
  return /^\s*(<!doctype html|<html[\s>])/i.test(doc.text.slice(0, 500));
}

function looksLikeFeed(text) {
  const head = text.slice(0, 2000);
  return /<rss[\s>]|<feed[\s>]|<rdf:rdf[\s>]/i.test(head) || /^\s*\{[\s\S]*"items"\s*:/.test(head);
}

/** Fetch a URL and, if it is an HTML page, follow its feed autodiscovery link. */
async function resolveFeed(url, conditional = {}) {
  let doc = await fetchDocument(url, conditional);
  let feedUrl = url;

  if (doc.ok && looksLikeHtml(doc) && !looksLikeFeed(doc.text)) {
    const alt = discoverFeed(doc.text, doc.url);
    if (!alt) throw new FetchError('That page does not link to an RSS or Atom feed');
    feedUrl = alt;
    doc = await fetchDocument(alt);
  }

  if (doc.status === 304) return { notModified: true, feedUrl, doc };
  if (!doc.ok) throw new FetchError(`Server returned HTTP ${doc.status}`, doc.status);
  return { notModified: false, feedUrl, doc };
}

async function pullFeed(feed, { conditional = true } = {}) {
  const headers = {};
  if (conditional) {
    if (feed.etag) headers['if-none-match'] = feed.etag;
    if (feed.lastModified) headers['if-modified-since'] = feed.lastModified;
  }

  try {
    const { notModified, feedUrl, doc } = await resolveFeed(feed.url, headers);
    feed.url = feedUrl;
    feed.lastFetched = new Date().toISOString();
    feed.error = null;
    if (notModified) return { ok: true, unchanged: true, count: (store.items[feed.id] || []).length };

    const parsed = parseFeed(doc.text, feedUrl);
    feed.title = parsed.info.title || feed.title || hostOf(feedUrl);
    if (parsed.info.siteUrl) feed.siteUrl = parsed.info.siteUrl;
    feed.description = parsed.info.description || feed.description || '';
    feed.kind = parsed.kind;
    feed.etag = doc.headers.get('etag') || null;
    feed.lastModified = doc.headers.get('last-modified') || null;

    const items = parsed.items.map((it) => ({ ...it, feedId: feed.id }));
    store.items[feed.id] = items;
    for (const it of items) index.set(it.id, { feedId: feed.id, item: it });
    return { ok: true, count: items.length };
  } catch (err) {
    feed.error = err.message || 'Failed to load feed';
    feed.lastFetched = new Date().toISOString();
    return { ok: false, error: feed.error };
  }
}

async function mapLimit(list, limit, fn) {
  const results = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (cursor < list.length) {
      const i = cursor++;
      results[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// serialization
// ---------------------------------------------------------------------------

function feedSummary(feed) {
  const items = store.items[feed.id] || [];
  const unread = items.reduce((n, it) => n + (store.read[it.id] ? 0 : 1), 0);
  return {
    id: feed.id,
    url: feed.url,
    title: feed.title || hostOf(feed.url),
    siteUrl: feed.siteUrl || '',
    description: feed.description || '',
    kind: feed.kind || '',
    lastFetched: feed.lastFetched || null,
    error: feed.error || null,
    counts: {
      total: items.length,
      unread,
      starred: items.reduce((n, it) => n + (store.starred[it.id] ? 1 : 0), 0),
    },
  };
}

function itemSummary(item, feed) {
  return {
    id: item.id,
    feedId: item.feedId,
    feedTitle: feed ? (feed.title || hostOf(feed.url)) : '',
    title: item.title,
    link: item.link,
    date: item.date,
    author: item.author,
    summary: item.summary,
    image: item.image,
    categories: item.categories,
    read: Boolean(store.read[item.id]),
    starred: Boolean(store.starred[item.id]),
  };
}

function aggregate({ feedId, filter, query, limit }) {
  const feedsById = new Map(store.feeds.map((f) => [f.id, f]));
  const list = [];
  for (const feed of store.feeds) {
    if (feedId && feed.id !== feedId) continue;
    for (const item of store.items[feed.id] || []) {
      list.push(itemSummary(item, feed));
    }
  }
  let out = list;
  if (filter === 'unread') out = out.filter((i) => !i.read);
  else if (filter === 'starred') out = out.filter((i) => i.starred);
  if (query) {
    const q = query.toLowerCase();
    out = out.filter((i) =>
      i.title.toLowerCase().includes(q)
      || (i.summary || '').toLowerCase().includes(q)
      || (i.feedTitle || '').toLowerCase().includes(q));
  }
  out.sort((a, b) => {
    const ta = a.date ? Date.parse(a.date) : 0;
    const tb = b.date ? Date.parse(b.date) : 0;
    return tb - ta;
  });
  if (limit) out = out.slice(0, limit);
  return { items: out, feedsById };
}

function totals() {
  let total = 0;
  let unread = 0;
  let starred = 0;
  for (const feed of store.feeds) {
    for (const item of store.items[feed.id] || []) {
      total++;
      if (!store.read[item.id]) unread++;
      if (store.starred[item.id]) starred++;
    }
  }
  return { total, unread, starred, feeds: store.feeds.length };
}

// ---------------------------------------------------------------------------
// http helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Invalid JSON body'); }
}

function normalizeUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) throw new Error('Enter a feed URL');
  if (!/^https?:\/\//i.test(value)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) throw new Error('Only http and https URLs are supported');
    value = `https://${value}`;
  }
  let url;
  try { url = new URL(value); } catch { throw new Error('That does not look like a valid URL'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http and https URLs are supported');
  if (!url.hostname.includes('.')) throw new Error('That does not look like a valid URL');
  url.hash = '';
  return url.toString();
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
  } catch {
    return sendJson(res, 400, { error: 'Bad request' });
  }
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) return sendJson(res, 404, { error: 'Not found' });
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'content-length': stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    sendJson(res, 500, { error: 'Failed to read file' });
  }
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const routes = [
  ['GET', /^\/api\/feeds$/, async (req, res) => {
    sendJson(res, 200, { feeds: store.feeds.map(feedSummary), totals: totals() });
  }],

  ['POST', /^\/api\/feeds$/, async (req, res) => {
    const body = await readJsonBody(req);
    let url;
    try { url = normalizeUrl(body.url); } catch (err) { return sendJson(res, 400, { error: err.message }); }

    const existing = store.feeds.find((f) => f.url === url);
    if (existing) {
      const result = await pullFeed(existing, { conditional: false });
      saveStore();
      if (!result.ok) return sendJson(res, 400, { error: existing.error || 'Could not load feed', feed: feedSummary(existing) });
      return sendJson(res, 200, { feed: feedSummary(existing), existed: true });
    }

    const feed = {
      id: crypto.randomUUID(),
      url,
      title: null,
      siteUrl: '',
      description: '',
      etag: null,
      lastModified: null,
      lastFetched: null,
      error: null,
    };

    const result = await pullFeed(feed, { conditional: false });
    if (!result.ok) return sendJson(res, 400, { error: feed.error || 'Could not load feed' });

    // The URL may have been resolved (site page -> feed) to one we already have.
    const duplicate = store.feeds.find((f) => f.url === feed.url);
    if (duplicate) {
      for (const it of store.items[feed.id] || []) index.delete(it.id);
      delete store.items[feed.id];
      return sendJson(res, 200, { feed: feedSummary(duplicate), existed: true });
    }

    store.feeds.push(feed);
    saveStore();
    sendJson(res, 201, { feed: feedSummary(feed) });
  }],

  ['DELETE', /^\/api\/feeds\/([\w-]+)$/, async (req, res, m) => {
    const id = m[1];
    const i = store.feeds.findIndex((f) => f.id === id);
    if (i === -1) return sendJson(res, 404, { error: 'Feed not found' });
    for (const item of store.items[id] || []) {
      delete store.read[item.id];
      delete store.starred[item.id];
      index.delete(item.id);
    }
    delete store.items[id];
    store.feeds.splice(i, 1);
    saveStore();
    sendJson(res, 200, { ok: true });
  }],

  ['POST', /^\/api\/feeds\/([\w-]+)\/refresh$/, async (req, res, m) => {
    const feed = store.feeds.find((f) => f.id === m[1]);
    if (!feed) return sendJson(res, 404, { error: 'Feed not found' });
    const result = await pullFeed(feed);
    saveStore();
    sendJson(res, result.ok ? 200 : 400, { ...result, feed: feedSummary(feed) });
  }],

  ['POST', /^\/api\/refresh$/, async (req, res) => {
    if (!store.feeds.length) return sendJson(res, 200, { ok: true, results: [] });
    const results = await mapLimit(store.feeds, 6, async (feed) => ({ id: feed.id, ...(await pullFeed(feed)) }));
    saveStore();
    sendJson(res, 200, { ok: true, results });
  }],

  ['GET', /^\/api\/items$/, async (req, res, _m, url) => {
    const filter = url.searchParams.get('filter') || 'all';
    const feedId = url.searchParams.get('feed') || '';
    const query = (url.searchParams.get('q') || '').trim();
    const limit = Math.min(Number(url.searchParams.get('limit')) || 500, 2000);
    const { items } = aggregate({ feedId, filter, query, limit });
    sendJson(res, 200, { items, totals: totals() });
  }],

  ['GET', /^\/api\/items\/([0-9a-f]+)$/, async (req, res, m) => {
    const entry = index.get(m[1]);
    if (!entry) return sendJson(res, 404, { error: 'Item not found' });
    const feed = store.feeds.find((f) => f.id === entry.feedId);
    sendJson(res, 200, {
      item: {
        ...itemSummary(entry.item, feed),
        content: entry.item.content || '',
      },
    });
  }],

  ['POST', /^\/api\/items\/([0-9a-f]+)\/read$/, async (req, res, m) => {
    const entry = index.get(m[1]);
    if (!entry) return sendJson(res, 404, { error: 'Item not found' });
    const body = await readJsonBody(req);
    const read = body.read === undefined ? true : Boolean(body.read);
    if (read) store.read[m[1]] = 1;
    else delete store.read[m[1]];
    saveStore();
    sendJson(res, 200, { ok: true, read, totals: totals() });
  }],

  ['POST', /^\/api\/items\/([0-9a-f]+)\/star$/, async (req, res, m) => {
    if (!index.has(m[1])) return sendJson(res, 404, { error: 'Item not found' });
    const body = await readJsonBody(req);
    const starred = body.starred === undefined ? true : Boolean(body.starred);
    if (starred) store.starred[m[1]] = 1;
    else delete store.starred[m[1]];
    saveStore();
    sendJson(res, 200, { ok: true, starred, totals: totals() });
  }],

  ['POST', /^\/api\/read-all$/, async (req, res) => {
    const body = await readJsonBody(req);
    const feedId = body.feed && body.feed !== 'all' ? body.feed : '';
    const filter = body.filter || 'all';
    for (const feed of store.feeds) {
      if (feedId && feed.id !== feedId) continue;
      for (const item of store.items[feed.id] || []) {
        if (filter === 'starred' && !store.starred[item.id]) continue;
        store.read[item.id] = 1;
      }
    }
    saveStore();
    sendJson(res, 200, { ok: true, totals: totals() });
  }],
];

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue;
      const match = pattern.exec(pathname);
      if (!match) continue;
      try {
        await handler(req, res, match, url);
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { error: err.message || 'Something went wrong' });
        else res.end();
      }
      return;
    }
    return sendJson(res, 404, { error: 'Unknown API route' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    return await serveStatic(req, res, pathname);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message || 'Something went wrong' });
    else res.end();
  }
}

await loadStore();

// Refresh stale feeds on boot (fire and forget).
if (store.feeds.length) {
  setTimeout(() => {
    mapLimit(store.feeds, 4, (feed) => pullFeed(feed)).then(saveStore).catch(() => {});
  }, 1500).unref?.();
}

const server = http.createServer(handle);
server.listen(PORT, HOST, () => {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch { /* pid file is a convenience only */ }
  console.log(`\n  RSS reader running at  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  Stop it with:  npm stop${PORT === 4173 ? '' : `   (or: PORT=${PORT} npm stop)`}\n`);
});

function removePidFile() {
  try {
    if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
  } catch { /* nothing to do */ }
}

function shutdown() {
  clearTimeout(saveTimer);
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(store), 'utf8'); } catch { /* best effort */ }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', removePidFile);
process.on('uncaughtException', (err) => {
  console.error('[rss] uncaught exception:', err);
  saveStore();
  setTimeout(() => process.exit(1), 300);
});
