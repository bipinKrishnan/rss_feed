/* Reader — client app */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    app: $('app'),
    sidebar: $('sidebar'),
    feedUrl: $('feedUrl'),
    addForm: $('addForm'),
    addBtn: $('addBtn'),
    addError: $('addError'),
    feedList: $('feedList'),
    suggestions: $('suggestions'),
    suggestChips: $('suggestChips'),
    sidebarFoot: $('sidebarFoot'),
    countAll: $('countAll'),
    countUnread: $('countUnread'),
    countStarred: $('countStarred'),
    listTitle: $('listTitle'),
    listSub: $('listSub'),
    listScroll: $('listScroll'),
    listLoading: $('listLoading'),
    itemList: $('itemList'),
    emptyState: $('emptyState'),
    search: $('search'),
    markAllBtn: $('markAllBtn'),
    refreshAll: $('refreshAll'),
    themeBtn: $('themeBtn'),
    menuBtn: $('menuBtn'),
    backdrop: $('backdrop'),
    reader: $('reader'),
    readerScroll: $('readerScroll'),
    readerPlaceholder: $('readerPlaceholder'),
    readerArticle: $('readerArticle'),
    readerMeta: $('readerMeta'),
    readerTitle: $('readerTitle'),
    readerByline: $('readerByline'),
    readerCrumbs: $('readerCrumbs'),
    readerFrame: $('readerFrame'),
    starBtn: $('starBtn'),
    readBtn: $('readBtn'),
    openOriginal: $('openOriginal'),
    backBtn: $('backBtn'),
    toast: $('toast'),
  };

  const SUGGESTIONS = [
    { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
    { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
    { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
    { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
    { name: 'Daring Fireball', url: 'https://daringfireball.net/feeds/main' },
    { name: 'xkcd', url: 'https://xkcd.com/rss.xml' },
  ];

  const state = {
    feeds: [],
    items: [],
    totals: { total: 0, unread: 0, starred: 0, feeds: 0 },
    filter: 'all',
    feedId: 'all',
    query: '',
    loading: false,
    refreshing: false,
    selectedId: null,
    detail: null,
    openToken: 0,
  };

  let toastTimer = null;
  let searchTimer = null;

  // ------------------------------------------------------------------ utils

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  function toast(message, kind) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.toggle('error', kind === 'error');
    els.toast.classList.add('show');
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3200);
  }

  function initials(title) {
    const words = String(title || '?').trim().split(/[\s.\-_]+/).filter(Boolean);
    if (!words.length) return '?';
    if (words.length === 1) return words[0].slice(0, 2);
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  function hashHue(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }

  function avatarColors(title) {
    const hue = hashHue(title || '');
    const dark = document.documentElement.dataset.theme === 'dark';
    return dark
      ? { background: `hsl(${hue} 24% 22%)`, color: `hsl(${hue} 60% 72%)` }
      : { background: `hsl(${hue} 45% 92%)`, color: `hsl(${hue} 45% 34%)` };
  }

  function resolveLink(link, siteUrl) {
    if (!link) return '';
    try {
      const u = new URL(link, siteUrl || undefined);
      return /^https?:$/.test(u.protocol) ? u.toString() : '';
    } catch { return ''; }
  }

  const dateFmt = new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  function fullDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : dateFmt.format(d);
  }

  function relTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const secs = Math.round((Date.now() - d.getTime()) / 1000);
    if (secs < 45) return 'just now';
    if (secs < 3600) return `${Math.max(1, Math.floor(secs / 60))}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    if (secs < 86400 * 7) return `${Math.floor(secs / 86400)}d ago`;
    return new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric',
      year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    }).format(d);
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function svgIcon(paths, extra = '') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;
  }

  const ICON_STAR = '<path d="M12 4l2.4 5 5.6.7-4.1 3.8 1.1 5.5L12 16.4 7 19l1.1-5.5L4 9.7 9.6 9z"/>';
  const ICON_TRASH = '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v5M14 11v5"/>';

  // -------------------------------------------------------------- data load

  async function loadFeeds() {
    const data = await api('/api/feeds');
    state.feeds = data.feeds;
    state.totals = data.totals;
    renderSidebar();
  }

  async function loadItems({ keepScroll = false } = {}) {
    if (!keepScroll) els.listScroll.scrollTop = 0;
    state.loading = true;
    els.listLoading.hidden = false;
    const params = new URLSearchParams({ filter: state.filter });
    if (state.feedId !== 'all') params.set('feed', state.feedId);
    if (state.query) params.set('q', state.query);
    try {
      const data = await api(`/api/items?${params}`);
      state.items = data.items;
      state.totals = data.totals;
      renderItems();
      refreshCountsUI();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      state.loading = false;
      els.listLoading.hidden = true;
    }
  }

  // ---------------------------------------------------------------- sidebar

  function renderSidebar() {
    // counts
    els.countAll.textContent = state.totals.total || '';
    els.countUnread.textContent = state.totals.unread || '';
    els.countStarred.textContent = state.totals.starred || '';
    els.sidebarFoot.textContent = state.feeds.length
      ? `${state.feeds.length} feed${state.feeds.length === 1 ? '' : 's'} · ${state.totals.unread} unread`
      : 'No feeds yet';
    els.sidebarFoot.title = 'Shortcuts: j / k move · m read · s star · r refresh · / search';

    // filter buttons
    document.querySelectorAll('.filter').forEach((btn) => {
      const active = state.feedId === 'all' && btn.dataset.filter === state.filter;
      btn.classList.toggle('active', active);
    });

    // feed list
    els.feedList.replaceChildren();
    for (const feed of state.feeds) {
      const colors = avatarColors(feed.title);
      const avatar = el('span', { class: 'feed-avatar', text: initials(feed.title) });
      avatar.style.background = colors.background;
      avatar.style.color = colors.color;
      if (feed.error) avatar.textContent = '!';

      const unread = el('span', { class: 'feed-unread', text: feed.counts.unread ? String(feed.counts.unread) : '' });
      const del = el('button', {
        class: 'feed-del',
        type: 'button',
        'aria-label': `Remove ${feed.title}`,
        title: 'Remove feed',
        html: svgIcon(ICON_TRASH),
      });

      const view = el('div', { class: 'feed-view' }, [
        avatar,
        el('span', { class: 'feed-name', text: feed.title }),
        unread,
        del,
      ]);

      const confirm = el('div', { class: 'feed-confirm' }, [
        el('span', { class: 'confirm-label', text: 'Remove feed?' }),
        el('button', { class: 'confirm-remove', type: 'button', text: 'Remove' }),
        el('button', { class: 'confirm-cancel', type: 'button', text: 'Cancel' }),
      ]);

      const row = el('li', {
        class: `feed${state.feedId === feed.id ? ' active' : ''}${feed.counts.unread ? ' has-unread' : ''}${feed.error ? ' has-error' : ''}`,
        dataset: { feedId: feed.id },
        title: feed.error ? `${feed.title}\n${feed.error}` : feed.url,
      }, [view, confirm]);
      els.feedList.append(row);
    }

    // suggestions
    const noFeeds = state.feeds.length === 0;
    els.suggestions.hidden = !noFeeds;
    if (noFeeds) fillChips(els.suggestChips);
  }

  function fillChips(container) {
    container.replaceChildren();
    for (const s of SUGGESTIONS) {
      container.append(el('button', {
        class: 'chip',
        type: 'button',
        text: s.name,
        title: s.url,
        onclick: () => {
          els.feedUrl.value = s.url;
          els.addForm.requestSubmit();
        },
      }));
    }
  }

  function refreshCountsUI() {
    els.countAll.textContent = state.totals.total || '';
    els.countUnread.textContent = state.totals.unread || '';
    els.countStarred.textContent = state.totals.starred || '';
    els.sidebarFoot.textContent = state.feeds.length
      ? `${state.feeds.length} feed${state.feeds.length === 1 ? '' : 's'} · ${state.totals.unread} unread`
      : 'No feeds yet';

    for (const li of els.feedList.querySelectorAll('.feed')) {
      const feed = state.feeds.find((f) => f.id === li.dataset.feedId);
      if (!feed) continue;
      const n = feed.counts.unread;
      const span = li.querySelector('.feed-unread');
      if (span) span.textContent = n ? String(n) : '';
      li.classList.toggle('has-unread', n > 0);
    }
    updateListSub();
  }

  function updateListSub() {
    if (state.feedId !== 'all') {
      const feed = state.feeds.find((f) => f.id === state.feedId);
      if (feed && feed.description) {
        els.listSub.textContent = feed.description;
        return;
      }
      if (feed && feed.error) {
        els.listSub.textContent = `Error: ${feed.error}`;
        return;
      }
    }
    const n = state.items.length;
    els.listSub.textContent = `${n} article${n === 1 ? '' : 's'}`;
  }

  function updateListTitle() {
    let title = 'All articles';
    if (state.feedId !== 'all') {
      const feed = state.feeds.find((f) => f.id === state.feedId);
      title = feed ? feed.title : 'Feed';
    } else if (state.filter === 'unread') title = 'Unread';
    else if (state.filter === 'starred') title = 'Starred';
    if (state.query) title = `Search: ${state.query}`;
    els.listTitle.textContent = title;
    updateListSub();
  }

  // ------------------------------------------------------------------- list

  function renderItems() {
    updateListTitle();
    els.itemList.replaceChildren();

    if (!state.items.length) {
      els.emptyState.hidden = false;
      els.emptyState.replaceChildren(buildEmpty());
      return;
    }
    els.emptyState.hidden = true;

    const frag = document.createDocumentFragment();
    for (const item of state.items) frag.append(itemRow(item));
    els.itemList.append(frag);
    setActiveRow(state.selectedId);
  }

  function buildEmpty() {
    const wrap = document.createDocumentFragment();

    let title = 'Nothing here yet';
    let text = 'Add a feed using the box on the left. Paste any RSS, Atom or site URL.';

    if (!state.feeds.length) {
      title = 'Your reading list is empty';
      text = 'Paste an RSS or Atom link (or just a site URL) into the box on the left. We will find the feed for you.';
    } else if (state.query) {
      title = 'No matching articles';
      text = `Nothing matches “${state.query}”. Try a different search.`;
    } else if (state.filter === 'unread') {
      title = "You're all caught up";
      text = 'No unread articles in this view.';
    } else if (state.filter === 'starred') {
      title = 'No starred articles';
      text = 'Press the star on any article to save it here.';
    } else if (state.feedId !== 'all') {
      title = 'No articles in this feed';
      text = 'The feed may be empty, or it may not have been refreshed yet.';
    }

    wrap.append(el('div', { html: svgIcon('<path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/>') }));
    wrap.append(el('h3', { text: title }));
    wrap.append(el('p', { text }));

    if (!state.feeds.length) {
      const chips = el('div', { class: 'chips' });
      fillChips(chips);
      wrap.append(el('div', { class: 'empty-suggest-title', text: 'Try one of these' }), chips);
    }
    return wrap;
  }

  function itemRow(item) {
    const feed = state.feeds.find((f) => f.id === item.feedId);

    const source = el('span', { class: 'item-source', text: item.feedTitle || (feed && feed.title) || 'Feed' });
    const top = el('div', { class: 'item-top' }, [source]);
    if (item.date) {
      top.append(el('span', { class: 'item-sep', text: '·' }));
      top.append(el('span', { class: 'item-time', text: relTime(item.date), title: fullDate(item.date) }));
    }

    const title = el('h3', { class: 'item-title', text: item.title });
    const summary = item.summary && item.summary !== item.title
      ? el('p', { class: 'item-summary', text: item.summary })
      : null;

    const main = el('div', { class: 'item-main' }, [top, title, summary]);

    const star = el('button', {
      class: 'item-star',
      'aria-label': item.starred ? 'Unstar article' : 'Star article',
      title: item.starred ? 'Starred' : 'Star (s)',
      html: svgIcon(ICON_STAR),
    });
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleStar(item.id);
    });

    const row = el('li', {
      class: `item${item.read ? '' : ' unread'}${item.starred ? ' starred' : ''}${state.selectedId === item.id ? ' active' : ''}`,
      dataset: { id: item.id },
      tabindex: '0',
      role: 'button',
    }, [main]);

    if (item.image) {
      const img = el('img', { class: 'item-thumb', src: item.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => img.remove());
      row.append(img);
    }
    row.append(star);

    row.addEventListener('click', () => openItem(item.id));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openItem(item.id);
      }
    });
    return row;
  }

  function rowFor(id) {
    return els.itemList.querySelector(`.item[data-id="${id}"]`);
  }

  function setActiveRow(id) {
    for (const row of els.itemList.querySelectorAll('.item.active')) row.classList.remove('active');
    if (!id) return;
    const row = rowFor(id);
    if (row) {
      row.classList.add('active');
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  function updateRow(id) {
    const item = state.items.find((i) => i.id === id);
    const row = rowFor(id);
    if (!item || !row) return;
    row.classList.toggle('unread', !item.read);
    row.classList.toggle('starred', Boolean(item.starred));
    const star = row.querySelector('.item-star');
    if (star) {
      star.title = item.starred ? 'Starred' : 'Star (s)';
      star.setAttribute('aria-label', item.starred ? 'Unstar article' : 'Star article');
    }
  }

  // ----------------------------------------------------------------- reader

  function showReaderLoading() {
    els.readerPlaceholder.hidden = true;
    els.readerArticle.hidden = true;
    let loader = $('readerLoading');
    if (!loader) {
      loader = el('div', { id: 'readerLoading', class: 'reader-loading', html: '<span class="spinner"></span>' });
      els.readerScroll.append(loader);
    }
    loader.hidden = false;
  }

  function showReaderPlaceholder() {
    const loader = $('readerLoading');
    if (loader) loader.hidden = true;
    els.readerArticle.hidden = true;
    els.readerPlaceholder.hidden = false;
    els.readerCrumbs.textContent = '';
  }

  async function openItem(id) {
    const token = ++state.openToken;
    const item = state.items.find((i) => i.id === id);
    if (!item) return;

    state.selectedId = id;
    setActiveRow(id);
    els.app.classList.add('reading');
    showReaderLoading();

    try {
      const data = await api(`/api/items/${encodeURIComponent(id)}`);
      if (token !== state.openToken) return;
      state.detail = data.item;
      renderReader(data.item);
      if (!data.item.read) await setRead(id, true, { silent: true });
    } catch (err) {
      if (token !== state.openToken) return;
      showReaderPlaceholder();
      toast(err.message, 'error');
    }
  }

  function renderReader(item) {
    const feed = state.feeds.find((f) => f.id === item.feedId);
    const loader = $('readerLoading');
    if (loader) loader.hidden = true;

    els.readerPlaceholder.hidden = true;
    els.readerArticle.hidden = false;

    // crumbs
    els.readerCrumbs.replaceChildren();
    els.readerCrumbs.append(el('strong', { text: feed ? feed.title : item.feedTitle || 'Feed' }));
    if (item.date) els.readerCrumbs.append(document.createTextNode(` · ${relTime(item.date)}`));

    // meta
    els.readerMeta.replaceChildren();
    if (feed) {
      els.readerMeta.append(el('button', {
        class: 'feed-name-link',
        text: feed.title,
        onclick: () => selectFeed(feed.id),
      }));
    }
    if (item.date) els.readerMeta.append(el('span', { text: fullDate(item.date) }));
    (item.categories || []).slice(0, 3).forEach((cat) => {
      els.readerMeta.append(el('span', { class: 'pill', text: cat }));
    });

    els.readerTitle.textContent = item.title || '(untitled)';
    els.readerByline.textContent = item.author ? `By ${item.author}` : '';
    els.readerByline.hidden = !item.author;

    const link = resolveLink(item.link, feed && feed.siteUrl);
    if (link) {
      els.openOriginal.href = link;
      els.openOriginal.hidden = false;
    } else {
      els.openOriginal.removeAttribute('href');
      els.openOriginal.hidden = true;
    }

    updateReaderButtons();

    // content
    els.readerFrame.srcdoc = buildReaderDoc(item, feed, link);
  }

  function buildReaderDoc(item, feed, link) {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    const text = v('--text', '#1d1b18');
    const muted = v('--muted', '#7b746a');
    const accent = v('--accent', '#d85427');
    const bg = v('--surface', '#ffffff');
    const border = v('--border', '#e7e2d9');
    const surface2 = v('--surface-2', '#f3f0ea');
    const mono = v('--font-mono', 'ui-monospace, monospace');
    const serif = v('--font-read', 'Georgia, serif');
    const dark = document.documentElement.dataset.theme === 'dark';

    const base = link || (feed && feed.siteUrl) || '';
    const baseTag = base ? `<base href="${base.replace(/"/g, '&quot;')}" target="_blank">` : '<base target="_blank">';

    const content = item.content && item.content.trim()
      ? item.content
      : '<p class="no-content">This feed only includes a short summary. Use “Open original” to read the full article.</p>';

    const css = `
      html { color-scheme: ${dark ? 'dark' : 'light'}; }
      body {
        margin: 0; padding: 2px 2px 56px;
        background: ${bg}; color: ${text};
        font-family: ${serif}; font-size: 18.5px; line-height: 1.72;
        -webkit-font-smoothing: antialiased; overflow-x: hidden;
        overflow-wrap: break-word;
      }
      p, ul, ol, pre, blockquote, figure, table { margin: 0 0 1.05em; }
      h1, h2, h3, h4, h5, h6 { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        line-height: 1.28; margin: 1.5em 0 .55em; letter-spacing: -.012em; }
      h1 { font-size: 1.55em; } h2 { font-size: 1.35em; } h3 { font-size: 1.17em; }
      h4, h5, h6 { font-size: 1em; }
      a { color: ${accent}; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
      a:hover { text-decoration-thickness: 2px; }
      img, video, iframe, svg { max-width: 100% !important; height: auto !important; }
      img { border-radius: 6px; display: block; margin: 1em auto; }
      figure { margin: 1.4em 0; } figcaption { font-size: .78em; color: ${muted}; text-align: center; margin-top: .5em; }
      blockquote { margin-left: 0; margin-right: 0; padding: .1em 0 .1em 1.1em; border-left: 3px solid ${accent};
        color: ${muted}; font-style: italic; }
      pre { background: ${surface2}; padding: 14px 16px; border-radius: 8px; overflow-x: auto;
        font-family: ${mono}; font-size: .78em; line-height: 1.55; border: 1px solid ${border}; }
      code { font-family: ${mono}; font-size: .82em; background: ${surface2}; padding: .12em .35em; border-radius: 4px; }
      pre code { background: none; padding: 0; font-size: 1em; }
      hr { border: none; border-top: 1px solid ${border}; margin: 2em 0; }
      table { width: 100%; border-collapse: collapse; font-size: .86em; display: block; overflow-x: auto; }
      th, td { border: 1px solid ${border}; padding: 7px 10px; text-align: left; }
      th { background: ${surface2}; }
      ul, ol { padding-left: 1.4em; }
      li { margin: .35em 0; }
      small { font-size: .82em; color: ${muted}; }
      .no-content { color: ${muted}; font-style: italic; }
      body > *:first-child { margin-top: 0 !important; }
      @media (max-width: 600px) { body { font-size: 17px; line-height: 1.66; } }
    `;

    return '<!doctype html><html><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + `<meta name="referrer" content="no-referrer">${baseTag}`
      + `<style>${css}</style></head><body>${content}</body></html>`;
  }

  function updateReaderButtons() {
    const item = state.detail;
    if (!item) return;
    els.starBtn.classList.toggle('on', Boolean(item.starred));
    els.starBtn.setAttribute('aria-pressed', item.starred ? 'true' : 'false');
    els.starBtn.title = item.starred ? 'Remove star (s)' : 'Star (s)';
    els.readBtn.textContent = item.read ? 'Mark unread' : 'Mark read';
    els.readBtn.hidden = false;
  }

  function closeReader() {
    els.app.classList.remove('reading');
    if (!window.matchMedia('(max-width: 1080px)').matches) {
      state.selectedId = null;
      state.detail = null;
      setActiveRow(null);
      showReaderPlaceholder();
    }
  }

  // -------------------------------------------------------------- mutations

  function adjustCounts(feed, du, ds) {
    state.totals.unread = Math.max(0, state.totals.unread + du);
    state.totals.starred = Math.max(0, state.totals.starred + ds);
    if (feed) {
      feed.counts.unread = Math.max(0, feed.counts.unread + du);
      feed.counts.starred = Math.max(0, feed.counts.starred + ds);
    }
    refreshCountsUI();
  }

  async function setRead(id, read, { silent = false } = {}) {
    const item = state.items.find((i) => i.id === id)
      || (state.detail && state.detail.id === id ? state.detail : null);
    const feed = item ? state.feeds.find((f) => f.id === item.feedId) : null;
    if (!item || item.read === read) {
      if (state.detail && state.detail.id === id) {
        state.detail.read = read;
        updateReaderButtons();
      }
      return;
    }

    item.read = read;
    if (state.detail && state.detail.id === id) state.detail.read = read;
    adjustCounts(feed, read ? -1 : 1, 0);
    updateRow(id);
    updateReaderButtons();

    try {
      const res = await api(`/api/items/${encodeURIComponent(id)}/read`, {
        method: 'POST', body: { read },
      });
      state.totals = res.totals;
      refreshCountsUI();
    } catch (err) {
      item.read = !read;
      if (state.detail && state.detail.id === id) state.detail.read = !read;
      adjustCounts(feed, read ? 1 : -1, 0);
      updateRow(id);
      updateReaderButtons();
      if (!silent) toast(err.message, 'error');
    }
  }

  async function toggleStar(id) {
    const item = state.items.find((i) => i.id === id)
      || (state.detail && state.detail.id === id ? state.detail : null);
    const detail = state.detail && state.detail.id === id ? state.detail : null;
    const feed = item ? state.feeds.find((f) => f.id === item.feedId) : null;
    if (!item) return;

    const next = !item.starred;
    item.starred = next;
    if (detail) detail.starred = next;
    adjustCounts(feed, 0, next ? 1 : -1);
    updateRow(id);
    updateReaderButtons();

    try {
      const res = await api(`/api/items/${encodeURIComponent(id)}/star`, {
        method: 'POST', body: { starred: next },
      });
      state.totals = res.totals;
      refreshCountsUI();
      if (!next && state.filter === 'starred') {
        state.items = state.items.filter((i) => i.id !== id);
        renderItems();
      }
    } catch (err) {
      item.starred = !next;
      if (detail) detail.starred = !next;
      adjustCounts(feed, 0, next ? -1 : 1);
      updateRow(id);
      updateReaderButtons();
      toast(err.message, 'error');
    }
  }

  function moveSelection(dir) {
    if (!state.items.length) return;
    let i = state.items.findIndex((it) => it.id === state.selectedId);
    if (i === -1) i = dir > 0 ? -1 : state.items.length;
    const next = state.items[i + dir];
    if (next) openItem(next.id);
  }

  async function markAllRead() {
    if (!state.items.length && state.filter === 'all') return;
    try {
      await api('/api/read-all', {
        method: 'POST',
        body: { feed: state.feedId, filter: state.filter },
      });
      for (const item of state.items) item.read = true;
      if (state.detail) state.detail.read = true;
      updateReaderButtons();
      if (state.filter === 'unread') state.items = [];
      renderItems();
      await loadFeeds();
      refreshCountsUI();
      toast('Marked as read');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function refreshAll({ silent = false } = {}) {
    if (state.refreshing) return;
    state.refreshing = true;
    els.refreshAll.classList.add('busy');
    try {
      const res = await api('/api/refresh', { method: 'POST' });
      const results = res.results || [];
      const failed = results.filter((r) => !r.ok);
      await Promise.all([loadFeeds(), loadItems({ keepScroll: true })]);
      if (failed.length === 0 && !silent) toast('Feeds refreshed');
      if (failed.length === 1) toast(`Could not refresh ${state.feeds.find((f) => f.id === failed[0].id)?.title || 'a feed'}`, 'error');
      else if (failed.length > 1) toast(`Could not refresh ${failed.length} feeds`, 'error');
    } catch (err) {
      if (!silent) toast(err.message, 'error');
    } finally {
      state.refreshing = false;
      els.refreshAll.classList.remove('busy');
    }
  }

  async function removeFeed(id) {
    const feed = state.feeds.find((f) => f.id === id);
    try {
      await api(`/api/feeds/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (state.feedId === id) {
        state.feedId = 'all';
        state.filter = 'all';
      }
      if (state.detail && state.detail.feedId === id) {
        state.selectedId = null;
        state.detail = null;
        showReaderPlaceholder();
        els.app.classList.remove('reading');
      }
      await loadFeeds();
      if (!state.feeds.length) {
        state.query = '';
        els.search.value = '';
      }
      await loadItems();
      refreshCountsUI();
      toast(`Removed ${feed ? feed.title : 'feed'}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function selectFeed(id) {
    state.feedId = id;
    state.filter = 'all';
    state.query = '';
    els.search.value = '';
    if (window.matchMedia('(max-width: 760px)').matches) closeNav();
    renderSidebar();
    loadItems();
  }

  function selectFilter(filter) {
    state.filter = filter;
    state.feedId = 'all';
    state.query = '';
    els.search.value = '';
    if (window.matchMedia('(max-width: 760px)').matches) closeNav();
    renderSidebar();
    loadItems();
  }

  // ---------------------------------------------------------------- nav/misc

  function openNav() {
    els.app.classList.add('nav-open');
    els.backdrop.hidden = false;
  }

  function closeNav() {
    els.app.classList.remove('nav-open');
    els.backdrop.hidden = true;
  }

  // ------------------------------------------------------------------ events

  els.addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = els.feedUrl.value.trim();
    if (!url) {
      els.feedUrl.focus();
      return;
    }
    els.addError.hidden = true;
    els.addForm.classList.add('busy');
    els.addBtn.setAttribute('aria-busy', 'true');
    els.feedUrl.disabled = true;
    try {
      const data = await api('/api/feeds', { method: 'POST', body: { url } });
      els.feedUrl.value = '';
      await loadFeeds();
      state.feedId = data.feed.id;
      state.filter = 'all';
      state.query = '';
      els.search.value = '';
      renderSidebar();
      await loadItems();
      toast(data.existed ? `Refreshed ${data.feed.title}` : `Added ${data.feed.title}`);
      if (window.matchMedia('(max-width: 760px)').matches) closeNav();
    } catch (err) {
      els.addError.textContent = err.message;
      els.addError.hidden = false;
    } finally {
      els.addForm.classList.remove('busy');
      els.addBtn.removeAttribute('aria-busy');
      els.feedUrl.disabled = false;
    }
  });

  els.feedUrl.addEventListener('input', () => { els.addError.hidden = true; });

  els.feedList.addEventListener('click', (e) => {
    const row = e.target.closest('.feed');
    if (!row) return;
    const id = row.dataset.feedId;

    if (e.target.closest('.feed-del')) {
      e.stopPropagation();
      row.classList.add('confirming');
      row.querySelector('.confirm-remove')?.focus();
      return;
    }
    if (e.target.closest('.confirm-remove')) {
      e.stopPropagation();
      removeFeed(id);
      return;
    }
    if (e.target.closest('.confirm-cancel')) {
      e.stopPropagation();
      row.classList.remove('confirming');
      row.querySelector('.feed-del')?.focus();
      return;
    }
    if (row.classList.contains('confirming')) return;
    selectFeed(id);
  });

  document.querySelectorAll('.filter').forEach((btn) => {
    btn.addEventListener('click', () => selectFilter(btn.dataset.filter));
  });

  els.markAllBtn.addEventListener('click', markAllRead);
  els.refreshAll.addEventListener('click', () => refreshAll());

  els.backBtn.addEventListener('click', closeReader);
  els.menuBtn.addEventListener('click', openNav);
  els.backdrop.addEventListener('click', closeNav);

  els.starBtn.addEventListener('click', () => {
    if (state.detail) toggleStar(state.detail.id);
  });

  els.readBtn.addEventListener('click', () => {
    if (state.detail) setRead(state.detail.id, !state.detail.read);
  });

  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const value = els.search.value.trim();
    searchTimer = setTimeout(() => {
      state.query = value;
      loadItems();
    }, 220);
  });

  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      els.search.value = '';
      state.query = '';
      els.search.blur();
      loadItems();
    }
  });

  els.themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('rss-theme', next); } catch { /* ignore */ }
    renderSidebar();
    if (state.detail) renderReader(state.detail);
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing) {
      if (e.key === 'Escape' && t.blur) t.blur();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        moveSelection(1);
        break;
      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        moveSelection(-1);
        break;
      case 'm':
        if (state.detail) {
          e.preventDefault();
          setRead(state.detail.id, !state.detail.read);
        }
        break;
      case 's':
        if (state.detail) {
          e.preventDefault();
          toggleStar(state.detail.id);
        }
        break;
      case 'o':
        if (state.detail && els.openOriginal.href) {
          e.preventDefault();
          window.open(els.openOriginal.href, '_blank', 'noopener');
        }
        break;
      case 'r':
        e.preventDefault();
        refreshAll();
        break;
      case '/':
        e.preventDefault();
        els.search.focus();
        els.search.select();
        break;
      case 'Escape': {
        const confirming = document.querySelector('.feed.confirming');
        if (confirming) {
          e.preventDefault();
          confirming.classList.remove('confirming');
          confirming.querySelector('.feed-del')?.focus();
          break;
        }
        closeReader();
        break;
      }
      default:
        break;
    }
  });

  window.addEventListener('resize', () => {
    if (!window.matchMedia('(max-width: 760px)').matches) closeNav();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.feeds.length) {
      refreshAll({ silent: true });
    }
  });

  setInterval(() => {
    if (document.visibilityState === 'visible' && state.feeds.length && !state.refreshing) {
      refreshAll({ silent: true });
    }
  }, 10 * 60 * 1000);

  // -------------------------------------------------------------------- boot

  (async function init() {
    try {
      await Promise.all([loadFeeds(), loadItems()]);
    } catch (err) {
      toast(`Could not reach the server: ${err.message}`, 'error');
    }
  })();
})();
