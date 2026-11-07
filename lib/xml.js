// Minimal, dependency-free XML parser + helpers.
// Handles elements, attributes, text, CDATA, comments, doctype and entities.
// Namespaces are flattened: `name` keeps the lowercased full name and `local`
// holds the part after the colon (so `content:encoded` -> local "encoded").

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  sbquo: '\u201a', bdquo: '\u201e', lsaquo: '\u2039', rsaquo: '\u203a',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', middot: '\u00b7', bull: '\u2022',
  laquo: '\u00ab', raquo: '\u00bb', deg: '\u00b0', minus: '\u2212',
  euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2',
  sect: '\u00a7', para: '\u00b6', times: '\u00d7', divide: '\u00f7',
  plusmn: '\u00b1', frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be',
  eacute: '\u00e9', egrave: '\u00e8', agrave: '\u00e0', ccedil: '\u00e7',
  uuml: '\u00fc', ouml: '\u00f6', auml: '\u00e4', ntilde: '\u00f1',
  aacute: '\u00e1', iacute: '\u00ed', oacute: '\u00f3', uacute: '\u00fa', szlig: '\u00df',
  shy: '\u00ad', zwj: '\u200d', zwnj: '\u200c', thinsp: '\u2009',
  ensp: '\u2002', emsp: '\u2003', rarr: '\u2192', larr: '\u2190',
  uarr: '\u2191', darr: '\u2193', harr: '\u2194', infin: '\u221e',
  iexcl: '\u00a1', iquest: '\u00bf', alpha: '\u03b1', beta: '\u03b2',
  gamma: '\u03b3', delta: '\u03b4', pi: '\u03c0', le: '\u2264', ge: '\u2265',
  ne: '\u2260', asymp: '\u2248', prime: '\u2032', Prime: '\u2033',
  dagger: '\u2020', Dagger: '\u2021', permil: '\u2030', oline: '\u203e',
  frasl: '\u2044', star: '\u2606', starf: '\u2605', check: '\u2713', cross: '\u2717',
  grave: '`', lowbar: '_', verbar: '|', bsol: '\\', sol: '/',
};

export function decodeEntities(str) {
  if (!str || str.indexOf('&') === -1) return str;
  return str.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const v = NAMED[ent] ?? NAMED[ent.toLowerCase()];
    return v === undefined ? m : v;
  });
}

export function escapeText(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeAttr(str) {
  return escapeText(str).replace(/"/g, '&quot;');
}

function findTagEnd(s, start) {
  let quote = null;
  for (let j = start; j < s.length; j++) {
    const c = s[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return j;
    }
  }
  return s.length;
}

function parseTagBody(body) {
  const m = /^\s*([^\s/>]+)/.exec(body);
  const name = (m ? m[1] : '').toLowerCase();
  const attrs = {};
  const rest = body.slice(m ? m[0].length : 0);
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let a;
  while ((a = re.exec(rest))) {
    attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
  }
  return { name, attrs };
}

export function parseXml(input) {
  const xml = String(input ?? '').replace(/^\uFEFF/, '');
  const doc = { name: '#document', local: '#document', attrs: {}, children: [], text: '' };
  const stack = [doc];
  const top = () => stack[stack.length - 1];
  const addText = (t) => { if (t) top().text += t; };

  let i = 0;
  const n = xml.length;

  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) { addText(decodeEntities(xml.slice(i))); break; }
    if (lt > i) addText(decodeEntities(xml.slice(i, lt)));

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      addText(xml.slice(lt + 9, end === -1 ? n : end));
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      // doctype / declaration, may contain an internal subset
      let j = lt + 2;
      let depth = 0;
      while (j < n) {
        const c = xml[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
        j++;
      }
      i = j + 1;
      continue;
    }

    const gt = findTagEnd(xml, lt + 1);
    const raw = xml.slice(lt + 1, gt);

    if (raw.trimStart().startsWith('/')) {
      const closing = raw.replace(/^\s*\/\s*/, '').trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === closing) { stack.length = k; break; }
      }
      i = gt + 1;
      continue;
    }

    const selfClosing = raw.trimEnd().endsWith('/');
    const { name, attrs } = parseTagBody(selfClosing ? raw.replace(/\/\s*$/, '') : raw);
    if (!name) { i = gt + 1; continue; }
    const node = {
      name,
      local: name.includes(':') ? name.slice(name.indexOf(':') + 1) : name,
      attrs,
      children: [],
      text: '',
    };
    top().children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }

  return doc;
}

// --- query helpers -------------------------------------------------------

export function elements(node) {
  return node ? node.children : [];
}

export function children(node, ...names) {
  if (!node) return [];
  const want = new Set(names.map((s) => s.toLowerCase()));
  return node.children.filter((c) => want.has(c.local) || want.has(c.name));
}

export function child(node, ...names) {
  return children(node, ...names)[0] || null;
}

export function descendant(node, ...names) {
  if (!node) return null;
  const want = new Set(names.map((s) => s.toLowerCase()));
  const queue = [...node.children];
  while (queue.length) {
    const cur = queue.shift();
    if (want.has(cur.local) || want.has(cur.name)) return cur;
    queue.push(...cur.children);
  }
  return null;
}

/** All text inside a node, including descendants. */
export function innerText(node) {
  if (!node) return '';
  let out = node.text || '';
  for (const c of node.children) out += innerText(c);
  return out;
}

/** Serialize a node's children back to markup (used for Atom xhtml content). */
const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);

export function serializeChildren(node) {
  if (!node) return '';
  return node.children.map(serializeNode).join('') + (node.text ? escapeText(node.text) : '');
}

function serializeNode(node) {
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');
  if (VOID.has(node.local)) return `<${node.name}${attrs}>`;
  return `<${node.name}${attrs}>${serializeChildren(node)}</${node.name}>`;
}
