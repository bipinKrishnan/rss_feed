import crypto from 'node:crypto';
import {
  parseXml, child, children, innerText, descendant, serializeChildren, decodeEntities,
} from './xml.js';

const MAX_ITEMS = 300;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function clean(str) {
  return String(str ?? '').replace(/\s+/g, ' ').trim();
}

function toIso(value) {
  const s = clean(value);
  if (!s) return null;
  // Try native parsing first (handles RFC 822, ISO 8601 and most variants).
  let t = Date.parse(s);
  if (Number.isNaN(t)) {
    // Some feeds use "2024-01-02 03:04:05" or "GMT" oddities.
    const alt = s.replace(/\s+GMT\s*$/i, ' +0000').replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/, '$1T$2');
    t = Date.parse(alt);
  }
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

function textOfLink(node) {
  if (!node) return '';
  const href = node.attrs.href || node.attrs.url;
  if (href) return clean(href);
  return clean(innerText(node));
}

/** Find the feed's own site link. */
function siteLink(node) {
  const links = children(node, 'link');
  for (const l of links) {
    const rel = (l.attrs.rel || '').toLowerCase();
    if (l.attrs.href && (rel === 'alternate' || rel === '')) return clean(l.attrs.href);
  }
  for (const l of links) {
    if (l.attrs.href) return clean(l.attrs.href);
    const t = clean(innerText(l));
    if (t) return t;
  }
  return '';
}

/** Find the link for an entry/item. */
function entryLink(node) {
  const links = children(node, 'link');
  let fallback = '';
  for (const l of links) {
    const href = l.attrs.href;
    const rel = (l.attrs.rel || 'alternate').toLowerCase();
    if (href && rel === 'alternate') return clean(href);
    if (href && !fallback) fallback = clean(href);
    if (!href) {
      const t = clean(innerText(l));
      if (t) return t;
    }
  }
  if (fallback) return fallback;
  const guid = child(node, 'guid');
  if (guid) {
    const v = clean(innerText(guid));
    const permalink = (guid.attrs.ispermalink || '').toLowerCase();
    if (/^https?:\/\//i.test(v) && permalink !== 'false') return v;
  }
  return '';
}

function firstImageInHtml(html) {
  if (!html) return null;
  const m = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(html);
  if (!m) return null;
  const src = decodeEntities(m[1] || m[2] || m[3] || '').trim();
  return /^(https?:)?\/\//i.test(src) || src.startsWith('/') ? src : null;
}

function mediaImage(node) {
  for (const c of node.children) {
    const l = c.local;
    const url = c.attrs.url || c.attrs.href || '';
    const type = (c.attrs.type || '').toLowerCase();
    const medium = (c.attrs.medium || '').toLowerCase();
    if (!url) continue;
    if (l === 'thumbnail') return url;
    if (type.startsWith('image/') || medium === 'image' || medium === 'picture') return url;
    if (l === 'enclosure' && /\.(jpe?g|png|gif|webp|avif)$/i.test(url)) return url;
  }
  return null;
}

function categoriesOf(node) {
  const out = [];
  for (const c of children(node, 'category')) {
    const label = c.attrs.term || c.attrs.label || clean(innerText(c));
    if (label) out.push(clean(label));
  }
  return [...new Set(out)].slice(0, 6);
}

function person(node) {
  if (!node) return '';
  return clean(innerText(child(node, 'name') || node));
}

function htmlToText(html) {
  if (!html) return '';
  return clean(
    decodeEntities(
      String(html)
        .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' '),
    ),
  );
}

function summarize(html, limit = 320) {
  const text = htmlToText(html);
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 120 ? lastSpace : limit).trimEnd()}\u2026`;
}

export function sanitizeHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<(script|style|iframe|object|embed|form|noscript|base)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|iframe|object|embed|form|noscript|base)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src|srcset|action)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, ' $1="#"')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function makeId(feedUrl, key) {
  return crypto.createHash('sha1').update(`${feedUrl}\n${key || ''}`).digest('hex').slice(0, 16);
}

function baseItem(n) {
  return {
    id: '',
    feedId: '',
    title: '',
    link: '',
    date: null,
    author: '',
    summary: '',
    content: '',
    image: null,
    categories: [],
    guid: '',
  };
}

function finishItem(item, feedUrl, index) {
  const key = item.guid || item.link || `${item.title}|${item.date || ''}|${index}`;
  item.id = makeId(feedUrl, key);
  item.title = clean(item.title) || '(untitled)';
  item.content = sanitizeHtml(item.content || '');
  if (!item.summary) item.summary = summarize(item.content);
  if (!item.image) item.image = firstImageInHtml(item.content);
  if (item.image && !/^(https?:)?\/\//i.test(item.image)) {
    try { item.image = new URL(item.image, item.link || feedUrl).toString(); } catch { item.image = null; }
  }
  if (!item.content) item.content = item.summary ? `<p>${item.summary}</p>` : '';
  if (!item.link) item.link = '';
  return item;
}

// ---------------------------------------------------------------------------
// RSS 2.0 / RSS 1.0 (RDF) / Atom
// ---------------------------------------------------------------------------

function parseRssItem(node, feedUrl, index) {
  const item = baseItem(node);
  item.title = innerText(child(node, 'title'));
  item.link = entryLink(node) || clean(innerText(child(node, 'link')));
  item.guid = clean(innerText(child(node, 'guid')));
  item.date = toIso(
    innerText(child(node, 'pubdate'))
    || innerText(child(node, 'date'))            // dc:date
    || innerText(child(node, 'published'))
    || innerText(child(node, 'updated')),
  );
  item.author = clean(innerText(child(node, 'creator')))  // dc:creator
    || clean(innerText(child(node, 'author')));
  const description = child(node, 'description');
  const encoded = child(node, 'encoded');
  const plainContent = child(node, 'content');
  // `<content>` in RSS is rare; ignore media:content (it carries a url attribute).
  const contentHtml = encoded
    ? innerText(encoded)
    : (plainContent && !plainContent.attrs.url ? innerText(plainContent) : '');
  item.content = contentHtml || (description ? innerText(description) : '');
  item.summary = summarize(item.content);
  item.image = mediaImage(node);
  item.categories = categoriesOf(node);
  item.feedId = '';
  return finishItem(item, feedUrl, index);
}

function parseAtomEntry(node, feedUrl, index) {
  const item = baseItem(node);
  item.title = innerText(child(node, 'title'));
  item.link = entryLink(node);
  item.guid = clean(innerText(child(node, 'id'))) || item.link;
  item.date = toIso(innerText(child(node, 'published')) || innerText(child(node, 'updated')));
  item.author = person(child(node, 'author'));
  item.categories = categoriesOf(node);

  const content = child(node, 'content');
  const summaryNode = child(node, 'summary');
  const type = ((content && content.attrs.type) || '').toLowerCase();
  let body = '';
  if (content) {
    if (type === 'xhtml' || type === 'application/xhtml+xml') body = serializeChildren(content);
    else if (type === 'text' || type === 'text/plain') body = `<p>${escapeHtml(innerText(content))}</p>`;
    else body = innerText(content);
  }
  item.content = body || (summaryNode ? innerText(summaryNode) : '');
  item.summary = summarize(body || (summaryNode ? innerText(summaryNode) : ''));
  item.image = mediaImage(node);
  return finishItem(item, feedUrl, index);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseRss(root, feedUrl) {
  const channel = root.local === 'channel' ? root : (child(root, 'channel') || root);
  const info = {
    title: clean(innerText(child(channel, 'title'))),
    siteUrl: siteLink(channel) || clean(innerText(child(channel, 'link'))),
    description: summarize(innerText(child(channel, 'description')), 240),
  };
  const items = children(channel, 'item').map((n, i) => parseRssItem(n, feedUrl, i));
  return { kind: 'rss', info, items };
}

function parseRdf(root, feedUrl) {
  const channel = child(root, 'channel');
  const info = {
    title: clean(innerText(child(channel, 'title'))),
    siteUrl: siteLink(channel) || clean(innerText(child(channel, 'link'))),
    description: summarize(innerText(child(channel, 'description')), 240),
  };
  const items = children(root, 'item').map((n, i) => parseRssItem(n, feedUrl, i));
  return { kind: 'rdf', info, items };
}

function parseAtom(root, feedUrl) {
  const info = {
    title: clean(innerText(child(root, 'title'))),
    siteUrl: siteLink(root),
    description: summarize(innerText(child(root, 'subtitle')), 240),
  };
  const items = children(root, 'entry').map((n, i) => parseAtomEntry(n, feedUrl, i));
  return { kind: 'atom', info, items };
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export function parseFeed(source, feedUrl) {
  const raw = String(source ?? '').replace(/^\uFEFF/, '').trim();
  if (!raw) throw new Error('Feed returned an empty document');

  // JSON Feed (https://www.jsonfeed.org/)
  if (raw.startsWith('{')) {
    let json;
    try { json = JSON.parse(raw); } catch { throw new Error('Invalid JSON feed'); }
    if (!Array.isArray(json.items)) throw new Error('JSON document is not a feed');
    const info = {
      title: clean(json.title) || hostOf(feedUrl),
      siteUrl: clean(json.home_page_url) || '',
      description: summarize(json.description, 240),
    };
    const items = json.items.slice(0, MAX_ITEMS).map((it, i) => {
      const item = baseItem();
      item.title = clean(it.title) || '(untitled)';
      item.link = clean(it.url) || clean(it.external_url) || '';
      item.guid = clean(it.id) || item.link;
      item.date = toIso(it.date_published || it.date_modified);
      item.author = clean(it.authors?.map?.((a) => a.name).filter(Boolean).join(', ')) || clean(it.author?.name);
      item.content = sanitizeHtml(it.content_html || '');
      item.summary = summarize(it.summary || item.content);
      item.image = clean(it.image) || firstImageInHtml(item.content);
      item.categories = [...new Set((it.tags || []).map(clean).filter(Boolean))].slice(0, 6);
      return finishItem(item, feedUrl, i);
    });
    return { kind: 'json', info, items };
  }

  const doc = parseXml(raw);
  const root = doc.children.find((c) => c.name !== '#comment');
  if (!root) throw new Error('Feed returned an empty document');
  const rn = root.local;

  let parsed;
  if (rn === 'rss' || rn === 'channel') parsed = parseRss(root, feedUrl);
  else if (rn === 'feed') parsed = parseAtom(root, feedUrl);
  else if (rn === 'rdf') parsed = parseRdf(root, feedUrl);
  else {
    const channel = descendant(root, 'channel');
    if (channel) parsed = parseRss(channel, feedUrl);
    else {
      const feed = descendant(root, 'feed');
      if (feed) parsed = parseAtom(feed, feedUrl);
      else throw new Error('Not a recognizable RSS, Atom or JSON feed');
    }
  }

  // de-duplicate by id, keep newest occurrence order
  const seen = new Set();
  parsed.items = parsed.items.filter((it) => {
    if (seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  }).slice(0, MAX_ITEMS);

  if (!parsed.info.title) parsed.info.title = hostOf(feedUrl);
  if (!parsed.info.siteUrl) {
    try { parsed.info.siteUrl = new URL(feedUrl).origin; } catch { /* ignore */ }
  }
  return parsed;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'Untitled feed'; }
}

/**
 * If the given URL is an HTML page, look for a feed autodiscovery <link>.
 * Returns the absolute feed URL, or null.
 */
export function discoverFeed(html, pageUrl) {
  if (!html) return null;
  const linkRe = /<link\b[^>]*>/gi;
  const candidates = [];
  let m;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    const attrs = {};
    const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let a;
    while ((a = attrRe.exec(tag))) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    const rel = (attrs.rel || '').toLowerCase();
    const type = (attrs.type || '').toLowerCase();
    if (!attrs.href) continue;
    if (!rel.split(/\s+/).includes('alternate')) continue;
    if (/rss|atom|feed\+json/.test(type)) candidates.push(attrs.href);
  }
  for (const c of candidates) {
    try {
      const abs = new URL(c, pageUrl).toString();
      if (/^https?:/i.test(abs)) return abs;
    } catch { /* ignore */ }
  }
  return null;
}

export { summarize, htmlToText };
