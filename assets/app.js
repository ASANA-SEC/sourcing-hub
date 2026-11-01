// Sourcing Hub — single-page app. Sections, their columns and who may do what all come
// from the data; every permission check here mirrors core.js, which the server enforces.
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const API = window.API;
  const CUR = CFG.CURRENCY || 'RM';
  const can = Core.can;

  const LEVEL_LABEL = { none: 'No access', viewer: 'Viewer', contributor: 'Contributor', editor: 'Editor', manager: 'Manager' };
  const LEVEL_HELP = {
    viewer: 'sees every item in the section',
    contributor: 'adds items and edits the ones they are an editor on',
    editor: 'edits and deletes any item',
    manager: 'everything an editor can do, plus changes the section’s columns',
  };
  const TYPE_LABEL = {
    text: 'Text', longtext: 'Long text', number: 'Number', currency: 'Amount (' + CUR + ')', percent: 'Percent',
    date: 'Date', datetime: 'Date & time', select: 'Dropdown', person: 'Person', checkbox: 'Tick box',
    link: 'Link to another section', url: 'Web link',
  };
  const COLOR_LABEL = { gray: 'Grey', blue: 'Blue', teal: 'Teal', green: 'Green', amber: 'Amber', red: 'Red', purple: 'Purple' };

  // ------------------------------------------------------------ state

  const S = {
    me: null, users: [], sections: [], items: [], comments: [], access: [],
    loaded: false, drawer: null, tpl: null,
    f: { q: '', who: 'all', view: {}, perf: { period: '30', sort: 'open' }, cal: { who: 'me', section: 'all', view: window.innerWidth < 760 ? 'agenda' : 'month', anchor: '' } },
  };
  try { S.f.view = JSON.parse(localStorage.getItem('sourcinghub_views') || '{}') || {}; } catch (e) { /* storage blocked */ }

  const $ = (sel, root) => (root || document).querySelector(sel);
  const app = $('#app');
  const drawerEl = $('#drawer');
  const toastEl = $('#toast');

  // ------------------------------------------------------------ helpers

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const nf2 = new Intl.NumberFormat('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf = new Intl.NumberFormat('en-MY', { maximumFractionDigits: 2 });
  const blank = (v) => v === '' || v === null || v === undefined;
  function money(n) { return CUR + ' ' + nf2.format(Number(n) || 0); }
  function moneyShort(n) {
    n = Number(n) || 0;
    const a = Math.abs(n);
    if (a >= 1e6) return CUR + ' ' + (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return CUR + ' ' + (n / 1e3).toFixed(0) + 'K';
    return CUR + ' ' + nf.format(Math.round(n));
  }
  function sum(arr, f) { return arr.reduce((t, x) => t + (Number(f(x)) || 0), 0); }
  const uid = () => Math.random().toString(36).slice(2, 8);

  function pad(n) { return String(n).padStart(2, '0'); }
  function dayStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function today() { return dayStr(new Date()); }
  function parseDay(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function parseDT(s) { if (!s) return null; const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? parseDay(s) : new Date(s); return isNaN(d) ? null : d; }
  function daysFromToday(s) { const d = parseDay(s); return d ? Math.round((d - parseDay(today())) / 864e5) : null; }
  function hoursUntil(s) { const d = parseDT(s); return d ? (d - Date.now()) / 36e5 : null; }
  function daysSince(iso) { const d = parseDT(iso); return d ? (Date.now() - d) / 864e5 : 0; }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(s) { const d = parseDT(s); return d ? d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear() : '—'; }
  function fmtShort(s) { const d = parseDT(s); return d ? d.getDate() + ' ' + MON[d.getMonth()] : '—'; }
  function fmtDT(s) { const d = parseDT(s); if (!d) return '—'; return fmtShort(s) + (/T\d/.test(s) ? ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) : ''); }
  function ago(iso) {
    const s = (Date.now() - (parseDT(iso) || Date.now())) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 86400 * 7) return Math.floor(s / 86400) + ' d ago';
    return fmtDate(iso);
  }

  const ctx = () => ({ me: S.me, access: S.access });
  const section = (id) => S.sections.find((s) => s.id === id);
  const item = (id) => S.items.find((i) => i.id === id);
  const liveSections = () => S.sections.filter((s) => !s.archived);
  const myLevel = (s) => Core.level(ctx(), s.id);
  const hasSectionAccess = (s) => s && !s.archived && Core.rank(myLevel(s)) >= 1;
  function user(id) { return S.users.find((u) => u.id === id); }
  function userName(id) { if (!id) return 'Unassigned'; const u = user(id); return (u && u.name) || id; }
  function initials(id) {
    const n = userName(id).replace(/\(.*?\)/g, '').trim();
    const parts = n.split(/[\s@._-]+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }
  function hue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  function avatar(id, lg) {
    if (!id) return '';
    return `<span class="av${lg ? ' lg' : ''}" style="background:hsl(${hue(id)} 42% 40%)" title="${esc(userName(id))}">${esc(initials(id))}</span>`;
  }
  function avatars(ids, max) {
    const list = [...new Set(ids.filter(Boolean))];
    const shown = list.slice(0, max || 3).map((id) => avatar(id)).join('');
    return `<span class="avs">${shown}${list.length > (max || 3) ? `<span class="av more">+${list.length - (max || 3)}</span>` : ''}</span>`;
  }

  // Columns and values
  const fieldOf = (s, key) => s.fields.find((f) => f.key === key);
  const stageF = (s) => (s.stageField ? fieldOf(s, s.stageField) : null);
  const dueF = (s) => s.fields.find((f) => f.due);
  const val = (it, f) => (f.key === 'title' ? it.title : (it.data || {})[f.key]);
  const optOf = (f, v) => (f && f.options || []).find((o) => o.value === v);
  const stageOpt = (s, it) => { const f = stageF(s); return f ? optOf(f, val(it, f)) : null; };
  const isDone = (s, it) => { const o = stageOpt(s, it); return !!(o && o.done); };
  const dueMet = (s, it) => { const o = stageOpt(s, it); return !!(o && o.met); };
  const sectionOf = (it) => section(it.sectionId);
  const involved = (it) => (it.editors || []).includes(S.me.id) || (it.collaborators || []).includes(S.me.id) ||
    (sectionOf(it) ? sectionOf(it).fields.some((f) => f.type === 'person' && val(it, f) === S.me.id) : false);
  function roleOn(it) {
    if ((it.editors || []).includes(S.me.id)) return 'Editor';
    if ((it.collaborators || []).includes(S.me.id)) return 'Collaborator';
    const s = sectionOf(it);
    const f = s && s.fields.find((x) => x.type === 'person' && val(it, x) === S.me.id);
    return f ? f.label : '';
  }

  function chip(c) { return c ? `<span class="chip ${c.cls}">${esc(c.text)}</span>` : ''; }
  function dueInfo(s, it) {
    const f = dueF(s);
    if (!f || isDone(s, it) || dueMet(s, it)) return null;
    const v = val(it, f);
    if (!v) return null;
    if (f.type === 'datetime') {
      const h = hoursUntil(v);
      if (h < 0) return { cls: 'crit', sev: 2, text: f.label + ' passed ' + fmtShort(v) };
      if (h <= 24) return { cls: 'crit', sev: 2, text: 'Due in ' + Math.max(1, Math.round(h)) + 'h' };
      if (h <= 72) return { cls: 'warn', sev: 1, text: 'Due in ' + Math.ceil(h / 24) + 'd' };
      return { cls: '', sev: 0, text: 'Due ' + fmtDT(v) };
    }
    const n = daysFromToday(v);
    if (n < 0) return { cls: 'crit', sev: 2, text: 'Late ' + -n + 'd' };
    if (n === 0) return { cls: 'warn', sev: 1, text: 'Due today' };
    if (n <= 3) return { cls: 'warn', sev: 1, text: 'Due in ' + n + 'd' };
    return { cls: '', sev: 0, text: 'Due ' + fmtShort(v) };
  }
  function ageInfo(s, it) {
    const o = stageOpt(s, it);
    if (!o || !o.alertDays || o.done) return null;
    const d = Math.floor(daysSince(it.stageChangedAt || it.createdAt));
    if (d < o.alertDays) return null;
    return { cls: d >= o.alertDays * 2 ? 'crit' : 'warn', sev: d >= o.alertDays * 2 ? 2 : 1, text: d + 'd in ' + o.label };
  }

  function show(s, it, f, mode) {
    const v = val(it, f);
    switch (f.type) {
      case 'currency': return blank(v) ? '' : mode === 'card' ? moneyShort(v) : money(v);
      case 'number': return blank(v) ? '' : nf.format(v);
      case 'percent':
        if (blank(v)) return '';
        return mode === 'table' ? `<span class="pbar"><i style="width:${Math.max(0, Math.min(100, v))}%"></i></span> ${nf.format(v)}%` : nf.format(v) + '%';
      case 'date': case 'datetime':
        if (!v) return '';
        if (f.due) { const d = dueInfo(s, it); if (d) return chip(d); }
        return f.type === 'date' ? fmtDate(v) : fmtDT(v);
      case 'select': { const o = optOf(f, v); return o ? `<span class="chip c-${o.color}">${esc(o.label)}</span>` : ''; }
      case 'person': return v ? `<span class="who">${avatar(v)}<span>${esc(userName(v))}</span></span>` : '';
      case 'checkbox': return v ? (mode === 'card' ? `<span class="chip c-blue">✓ ${esc(f.label)}</span>` : '✓') : '';
      case 'link': { if (!v) return ''; const t = item(v); return t ? esc(t.title) : '<span class="muted">(no access)</span>'; }
      case 'url': return v && /^https?:\/\//i.test(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v.replace(/^https?:\/\//, '').slice(0, 40))}</a>` : '';
      case 'longtext': return esc(String(v || '').slice(0, 90)) + (String(v || '').length > 90 ? '…' : '');
      default: return esc(v);
    }
  }

  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* blocked */ } }
  function saveViews() { try { localStorage.setItem('sourcinghub_views', JSON.stringify(S.f.view)); } catch (e) { /* blocked */ } }

  let toastTimer;
  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.className = 'toast' + (isErr ? ' err' : '');
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, isErr ? 6000 : 2600);
  }

  const AUTH_CODES = ['AUTH_REQUIRED', 'AUTH_INVALID', 'AUTH_EXPIRED', 'NOT_INVITED'];
  function handleError(e) {
    if (e && AUTH_CODES.includes(e.code)) {
      closeDrawer();
      signOut(e.message);
      return;
    }
    toast((e && e.message) || 'Something went wrong. Try again.', true);
  }

  // ------------------------------------------------------------ sign-in

  function jwtExpired(t) {
    try {
      const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return !p.exp || p.exp * 1000 < Date.now() + 60000;
    } catch (e) { return true; }
  }

  async function boot() {
    if (API.mode === 'remote') {
      if (!CFG.GOOGLE_CLIENT_ID) {
        app.innerHTML = '<div class="boot">GOOGLE_CLIENT_ID is missing in config.js. See README.md, step 1.</div>';
        return;
      }
      const t = ssGet('sourcinghub_token');
      if (t && !jwtExpired(t)) { API.token = t; await loadData(); } else showLogin();
    } else if (API.restore()) {
      await loadData();
    } else {
      showLogin();
    }
  }

  let gisLoading;
  function loadGis() {
    if (window.google && google.accounts) return Promise.resolve();
    if (!gisLoading) {
      gisLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.onload = resolve;
        s.onerror = () => { gisLoading = null; reject(new Error('Could not load Google Sign-In. Check your connection.')); };
        document.head.appendChild(s);
      });
    }
    return gisLoading;
  }

  function showLogin(message) {
    S.loaded = false;
    document.title = 'Sign in · Sourcing Hub';
    const demo = API.mode === 'demo';
    if (demo) S.users = API.accounts();
    app.innerHTML = `
      <div class="signin"><div class="box">
        <div class="brand"><span class="mark">SH</span><div><b style="color:var(--ink)">${esc(CFG.COMPANY_NAME || 'Sourcing Hub')}</b></div></div>
        <div><h1>Sign in</h1><p>For authorised users only. Accounts are created by the super admin.</p></div>
        ${message ? `<div class="err">${esc(message)}</div>` : ''}
        ${demo ? `
          <div class="demo-note"><b>Demo mode.</b> Google sign-in starts working once the Google setup in README.md is done. Until then, pick an example account to see what each access level can do.</div>
          <div class="acct-list">${API.accounts().map((a) => `
            <button type="button" class="acct" data-act="demo-login" data-id="${esc(a.id)}">${avatar(a.id, true)}
              <span><b>${esc(a.name || a.id)}</b><small>${esc(a.note)}</small></span></button>`).join('')}</div>
          <button type="button" class="linkbtn" data-act="reset-demo">Reset example data</button>`
        : '<div id="gbtn"></div><p class="muted" style="font-size:12.5px">Use the Google account your super admin added.</p>'}
      </div></div>`;
    if (demo) return;
    loadGis().then(() => {
      google.accounts.id.initialize({
        client_id: CFG.GOOGLE_CLIENT_ID,
        callback: (resp) => {
          API.token = resp.credential;
          ssSet('sourcinghub_token', resp.credential);
          loadData();
        },
        auto_select: !message,
      });
      const el = $('#gbtn');
      if (el) google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', text: 'signin_with', width: 300 });
      if (!message) google.accounts.id.prompt();
    }).catch((e) => toast(e.message, true));
  }

  function signOut(message) {
    if (API.mode === 'remote') {
      ssSet('sourcinghub_token', null);
      API.token = null;
      if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
    } else {
      API.logout();
    }
    S.tpl = null;
    showLogin(message);
  }

  async function loadData(silent) {
    try {
      const res = await API.call('bootstrap');
      S.me = res.me;
      S.users = res.users || [];
      S.sections = res.sections || [];
      S.items = res.items || [];
      S.comments = res.comments || [];
      S.access = res.access || [];
      S.sourcing = res.sourcing || [];
      S.emails = res.emails || [];
      S.quotes = res.quotes || [];
      S.settings = res.settings || null;
      if (!S.loaded) { S.loaded = true; renderShell(); }
      render();
    } catch (e) {
      if (!silent) handleError(e);
    }
  }

  // ------------------------------------------------------------ shell

  const ICON = {
    dashboard: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
    mywork: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    performance: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    sections: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M17.5 14v7M14 17.5h7"/>',
    team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
    sourcing: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  };
  const svg = (k) => `<svg viewBox="0 0 24 24">${ICON[k]}</svg>`;
  function secMark(s) { return `<span class="smark" style="background:hsl(${hue(s.id)} 38% 42%)">${esc((s.name || '?').trim()[0].toUpperCase())}</span>`; }

  function renderShell() {
    app.innerHTML = `
      <div class="shell">
        <aside class="side">
          <div class="brand"><span class="mark">SH</span><div><b>${esc(CFG.COMPANY_NAME || 'Sourcing Hub')}</b>${(CFG.COMPANY_NAME || 'Sourcing Hub') === 'Sourcing Hub' ? '' : '<small>Sourcing Hub</small>'}</div></div>
          <button type="button" class="gs-btn" data-act="search-open" aria-label="Search all sections"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><span class="lbl">Search</span><kbd>Ctrl K</kbd></button>
          <nav class="nav" id="nav"></nav>
          <div class="side-foot">
            <div class="me">${avatar(S.me.id, true)}<div class="who"><b>${esc(S.me.name || S.me.id)}</b><small>${S.me.isSuper ? 'Super admin' : esc(S.me.id)}</small></div></div>
            <div class="links"><a href="https://asana-sec.github.io/project-hub/help.html" target="_blank" rel="noopener">Help</a><button type="button" data-act="refresh">Refresh</button><button type="button" data-act="signout">Sign out</button></div>
          </div>
        </aside>
        <main class="main" id="main"></main>
      </div>
      <div id="gsearch" class="gsearch" hidden>
        <div class="scrim" data-act="search-close"></div>
        <div class="gs-box" role="dialog" aria-modal="true" aria-label="Search all sections">
          <div class="gs-in"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
            <input id="gsInput" type="text" placeholder="Search titles, numbers, clients, people, comments…" autocomplete="off" aria-label="Search">
            <button type="button" class="x" data-act="search-close" aria-label="Close">×</button></div>
          <div id="gsResults" class="gs-res" role="listbox"></div>
          <div class="gs-foot">Searches every section you can open, plus items you are named on · ↑ ↓ to move · Enter to open · Esc to close</div>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------ global search

  function searchFields(it) {
    const s = sectionOf(it);
    const parts = [{ label: 'Title', text: it.title }];
    s.fields.forEach((f) => {
      if (f.key === 'title') return;
      const v = val(it, f);
      if (blank(v) || v === false) return;
      let text = '';
      if (['text', 'longtext', 'url'].includes(f.type)) text = String(v);
      else if (f.type === 'select') text = (optOf(f, v) || {}).label || '';
      else if (f.type === 'person') text = userName(v);
      else if (f.type === 'link') text = (item(v) || {}).title || '';
      else if (['number', 'currency'].includes(f.type)) text = String(v);
      if (text) parts.push({ label: f.label, text });
    });
    const people = (it.editors || []).concat(it.collaborators || []).map(userName).join(', ');
    if (people) parts.push({ label: 'People', text: people });
    S.comments.filter((c) => c.itemId === it.id && c.kind !== 'log').forEach((c) => parts.push({ label: 'Comment by ' + userName(c.author), text: c.text }));
    return parts;
  }

  function hl(text, terms) {
    let out = esc(text);
    terms.forEach((t) => { if (t) out = out.replace(new RegExp('(' + esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>'); });
    return out;
  }

  function runSearch(q) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return { terms, items: [], sections: [] };
    // One- or two-letter words match the start of a word only ("b" finds "Client B", not every b)
    const rx = terms.map((t) => (t.length <= 2 ? new RegExp('(^|[^a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : null));
    const has = (text, i) => (rx[i] ? rx[i].test(text) : text.includes(terms[i]));
    const hasAll = (text) => terms.every((t, i) => has(text, i));
    const secs = liveSections().filter((s) => hasAll(s.name.toLowerCase()));
    const items = [];
    S.items.forEach((it) => {
      const s = sectionOf(it);
      if (!s || s.archived) return;
      const parts = searchFields(it);
      const all = parts.map((p) => p.text).join(' \n ').toLowerCase();
      if (!hasAll(all)) return;
      const titleHit = hasAll(it.title.toLowerCase());
      const why = titleHit ? null : parts.find((p) => p.label !== 'Title' && terms.some((t, i) => has(p.text.toLowerCase(), i)));
      items.push({ it, s, titleHit, why });
    });
    items.sort((a, b) => (b.titleHit - a.titleHit) || (b.it.updatedAt || '').localeCompare(a.it.updatedAt || ''));
    return { terms, items: items.slice(0, 60), more: Math.max(0, items.length - 60), sections: secs };
  }

  function renderSearch() {
    const q = $('#gsInput').value.trim();
    const box = $('#gsResults');
    const r = runSearch(q);
    S.gs = { list: [] };
    if (!q) { box.innerHTML = '<div class="gs-empty">Type to search. Try an RFQ number, a client or a person’s name.</div>'; return; }
    let html = '';
    r.sections.forEach((s) => {
      S.gs.list.push({ href: '#s/' + s.id });
      html += `<button type="button" class="gs-row" role="option" data-act="gs-go" data-i="${S.gs.list.length - 1}">${secMark(s)}<span class="gs-t"><b>${hl(s.name, r.terms)}</b><small>Open section</small></span></button>`;
    });
    let lastSec = null;
    r.items.forEach((x) => {
      if (x.s.id !== lastSec) { html += `<div class="gs-h">${esc(x.s.name)}</div>`; lastSec = x.s.id; }
      S.gs.list.push({ id: x.it.id });
      const so = stageOpt(x.s, x.it);
      const snippet = x.why ? `${esc(x.why.label)}: ${hl(x.why.text.length > 120 ? x.why.text.slice(0, 120) + '…' : x.why.text, r.terms)}` : esc(x.s.name);
      html += `<button type="button" class="gs-row" role="option" data-act="gs-go" data-i="${S.gs.list.length - 1}">${secMark(x.s)}
        <span class="gs-t"><b>${hl(x.it.title, r.terms)}</b><small>${snippet}</small></span>${so ? `<span class="chip c-${so.color}">${esc(so.label)}</span>` : ''}</button>`;
    });
    if (r.more) html += `<div class="gs-empty">${r.more} more match. Add another word to narrow it down.</div>`;
    box.innerHTML = html || `<div class="gs-empty">No matches for “${esc(q)}” in the sections you can open.</div>`;
    S.gs.sel = 0;
    markSel();
  }
  function markSel() {
    const rows = document.querySelectorAll('#gsResults .gs-row');
    rows.forEach((el, i) => { el.classList.toggle('on', i === S.gs.sel); el.setAttribute('aria-selected', i === S.gs.sel); });
    if (rows[S.gs.sel]) rows[S.gs.sel].scrollIntoView({ block: 'nearest' });
  }
  function openSearch() {
    const g = $('#gsearch');
    if (!g) return;
    g.hidden = false;
    const inp = $('#gsInput');
    inp.focus();
    inp.select();
    renderSearch();
  }
  function closeSearch() { const g = $('#gsearch'); if (g) g.hidden = true; }
  function goSearch(i) {
    const hit = S.gs && S.gs.list[i];
    if (!hit) return;
    closeSearch();
    if (hit.href) location.hash = hit.href; else openItem(hit.id);
  }

  function renderNav(active) {
    const late = S.items.filter((it) => { const s = sectionOf(it); if (!s || !involved(it)) return false; const d = dueInfo(s, it); return d && d.sev === 2; }).length;
    const link = (href, key, label, icon, count) => `<a href="${href}" data-nav="${key}">${icon}<span class="lbl">${label}</span>${count ? `<span class="count">${count}</span>` : ''}</a>`;
    let html = link('#dashboard', 'dashboard', 'Dashboard', svg('dashboard')) + link('#mywork', 'mywork', 'My Work', svg('mywork'), late) + link('#calendar', 'calendar', 'Calendar', svg('calendar'))
      + (canPerf() ? link('#performance', 'performance', 'Team performance', svg('performance')) : '')
      + (srcAccess().view ? link('#sourcing', 'sourcing', 'RFQ Sourcing', svg('sourcing')) : '');
    const secs = liveSections();
    if (secs.length) html += '<div class="nav-h">Sections</div>' + secs.map((s) => link('#s/' + s.id, 's/' + s.id, esc(s.name), secMark(s))).join('');
    if (S.me.isSuper) html += '<div class="nav-h">Super admin</div>' + link('#sections', 'sections', 'Manage sections', svg('sections')) + link('#team', 'team', 'Users &amp; access', svg('team')) + link('#mailsettings', 'mailsettings', 'Email settings', svg('sourcing'));
    const nav = $('#nav');
    nav.innerHTML = html;
    nav.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.nav === active));
  }

  function demoBanner() {
    if (API.mode !== 'demo' || API.clean) return '';
    return `<div class="banner"><b>Demo mode</b><span>Signed in as ${esc(S.me.name)} with example data saved in this browser only.</span><button type="button" data-act="signout">Switch account</button></div>`;
  }

  function route() {
    const parts = decodeURIComponent((location.hash || '#dashboard').slice(1)).split('/');
    return { view: parts[0] || 'dashboard', id: parts[1], sub: parts[2] };
  }

  function render() {
    if (!S.loaded) return;
    const main = $('#main');
    if (!main) return;
    const r = route();
    let html = '';
    let nav = r.view;
    let title = 'Dashboard';
    if (r.view === 's' && r.sub === 'customize') { html = viewCustomize(r.id); nav = 's/' + r.id; title = 'Customize'; }
    else if (r.view === 's') { html = viewSection(r.id); nav = 's/' + r.id; title = (section(r.id) || {}).name || 'Section'; }
    else if (r.view === 'mywork' || r.view === 'item') { html = viewMyWork(); nav = 'mywork'; title = 'My Work'; }
    else if (r.view === 'calendar') { html = viewCalendar(); title = 'Calendar'; }
    else if (r.view === 'performance') { html = viewPerformance(); title = 'Team performance'; }
    else if (r.view === 'sourcing') { html = r.id ? viewSourcingTask(r.id) : viewSourcing(); title = 'RFQ Sourcing'; }
    else if (r.view === 'mailsettings') { html = viewMailSettings(); title = 'Email settings'; }
    else if (r.view === 'sections') { html = viewSections(); title = 'Manage sections'; }
    else if (r.view === 'team') { html = viewTeam(); title = 'Users & access'; }
    else { html = viewDashboard(); nav = 'dashboard'; }
    renderNav(nav);
    const board = $('.board', main);
    const keepLeft = board ? board.scrollLeft : 0;
    const keepTop = window.scrollY;
    main.innerHTML = demoBanner() + html;
    const nb = $('.board', main);
    if (nb && keepLeft) nb.scrollLeft = keepLeft;
    if (S._last === location.hash) window.scrollTo(0, keepTop);
    S._last = location.hash;
    document.title = title + ' · Sourcing Hub';
    // Shared links and Google Calendar events open the item directly, full screen: #item/<id>
    if (r.view === 'item' && r.id) {
      history.replaceState(null, '', '#mywork');
      openItem(r.id, true);
    }
  }

  // ------------------------------------------------------------ calendar

  const userOn = (it, uid) => (it.editors || []).includes(uid) || (it.collaborators || []).includes(uid) ||
    (sectionOf(it) ? sectionOf(it).fields.some((f) => f.type === 'person' && val(it, f) === uid) : false);
  const managed = () => liveSections().filter((s) => myLevel(s) === 'manager').map((s) => s.id);

  function calOptions() {
    const mon = Core.monitorable(ctx(), S.sections, S.items, S.users);
    const opts = [{ value: 'me', label: 'My calendar' }];
    if (S.me.isSuper) opts.push({ value: 'team', label: 'Everyone' });
    else if (managed().length) opts.push({ value: 'team', label: 'Everyone in the sections I manage' });
    S.users.filter((u) => u.id !== S.me.id && mon[u.id]).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
      .forEach((u) => opts.push({ value: u.id, label: u.name || u.id }));
    return { opts, mon };
  }

  function calEntries() {
    const c = S.f.cal;
    const { mon } = calOptions();
    let items;
    if (c.who === 'team' && (S.me.isSuper || managed().length)) {
      const ids = managed();
      items = S.items.filter((it) => S.me.isSuper || ids.includes(it.sectionId));
    } else if (c.who !== 'me' && mon[c.who]) {
      const scope = mon[c.who];
      items = S.items.filter((it) => userOn(it, c.who) && (scope === '*' || scope.includes(it.sectionId)));
    } else {
      items = S.items.filter((it) => userOn(it, S.me.id));
    }
    return items.map((it) => {
      const s = sectionOf(it);
      if (!s || s.archived || (c.section !== 'all' && s.id !== c.section)) return null;
      const f = dueF(s);
      const v = f && val(it, f);
      if (!v) return null;
      const d = dueInfo(s, it);
      return { it, s, day: v.slice(0, 10), time: /T\d/.test(v) ? v.slice(11, 16) : '', done: isDone(s, it), late: !!(d && d.sev === 2) };
    }).filter(Boolean).sort((a, b) => (a.day + (a.time || '00:00')).localeCompare(b.day + (b.time || '00:00')));
  }

  function evChip(e, full) {
    return `<button type="button" class="ev${e.done ? ' done' : ''}${e.late ? ' late' : ''}" style="--h:${hue(e.s.id)}" data-act="open" data-id="${esc(e.it.id)}" title="${esc(e.s.name + ' · ' + e.it.title)}">
      ${e.time ? `<span class="evt">${e.time}</span>` : ''}<span class="evn">${esc(e.it.title)}</span>${full ? `<span class="evs">${esc(e.s.name)}${(e.it.editors || []).length ? ' · ' + esc(e.it.editors.map(userName).join(', ')) : ''}</span>` : ''}</button>`;
  }

  function viewCalendar() {
    const c = S.f.cal;
    const { opts } = calOptions();
    if (!opts.some((o) => o.value === c.who)) c.who = 'me';
    const entries = calEntries();
    const byDay = {};
    entries.forEach((e) => { (byDay[e.day] = byDay[e.day] || []).push(e); });
    const anchor = parseDay(c.anchor) || new Date();
    const t = today();
    let title = '';
    let body = '';
    const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const mondayOf = (d) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

    if (c.view === 'month') {
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const start = mondayOf(first);
      title = first.toLocaleString('en-MY', { month: 'long', year: 'numeric' });
      let cells = '';
      for (let i = 0; i < 42; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        if (i >= 35 && d.getMonth() !== first.getMonth()) break;
        const k = dayStr(d);
        const list = byDay[k] || [];
        cells += `<div class="cday${d.getMonth() !== first.getMonth() ? ' out' : ''}${k === t ? ' today' : ''}">
          <button type="button" class="cnum" data-act="cal-day" data-day="${k}" aria-label="Show week of ${fmtDate(k)}">${d.getDate()}</button>
          ${list.slice(0, 3).map((e) => evChip(e)).join('')}
          ${list.length > 3 ? `<button type="button" class="more" data-act="cal-day" data-day="${k}">+${list.length - 3} more</button>` : ''}</div>`;
      }
      body = `<div class="cgrid"><div class="cdow">${DOW.map((x) => `<span>${x}</span>`).join('')}</div><div class="cdays">${cells}</div></div>`;
    } else if (c.view === 'week') {
      const start = mondayOf(anchor);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      title = fmtDate(dayStr(start)) + ' – ' + fmtDate(dayStr(end));
      let cols = '';
      for (let i = 0; i < 7; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const k = dayStr(d);
        const list = byDay[k] || [];
        cols += `<div class="wday${k === t ? ' today' : ''}"><div class="wh"><b>${DOW[i]}</b> ${d.getDate()} ${MON[d.getMonth()]}</div>${list.map((e) => evChip(e, true)).join('') || '<div class="none">—</div>'}</div>`;
      }
      body = `<div class="cweek">${cols}</div>`;
    } else {
      title = 'From ' + fmtDate(dayStr(anchor));
      const from = dayStr(anchor);
      const overdue = from === t ? entries.filter((e) => e.late && e.day < t) : [];
      const upcoming = entries.filter((e) => e.day >= from).slice(0, 150);
      const days = [...new Set(upcoming.map((e) => e.day))];
      body = `<div class="agenda">
        ${overdue.length ? `<div class="aday"><div class="ah crit">Overdue · ${overdue.length}</div>${overdue.map((e) => evChip(e, true)).join('')}</div>` : ''}
        ${days.map((k) => `<div class="aday"><div class="ah${k === t ? ' now' : ''}">${k === t ? 'Today · ' : ''}${fmtDate(k)}</div>${upcoming.filter((e) => e.day === k).map((e) => evChip(e, true)).join('')}</div>`).join('')}
        ${!days.length && !overdue.length ? '<div class="empty-state"><b>Nothing scheduled</b>Items appear here when their deadline column has a date.</div>' : ''}</div>`;
    }

    const secs = liveSections().filter((s) => dueF(s));
    const whoLabel = (opts.find((o) => o.value === c.who) || opts[0]).label;
    const sync = API.mode === 'demo' && !API.clean
      ? 'In the live version, every item with a deadline is also added to the Google Calendar of its editors, collaborators and named people.'
      : 'Items with a deadline are also added to the Google Calendar of their editors, collaborators and named people, and update when the item changes.';
    return `
      <div class="head"><div><h1>Calendar</h1><div class="sub">${esc(whoLabel)} · ${entries.length} dated item${entries.length === 1 ? '' : 's'}${entries.filter((e) => e.late).length ? ` · <b style="color:var(--crit)">${entries.filter((e) => e.late).length} late</b>` : ''}</div></div>
        ${S.me.isSuper && API.mode === 'remote' ? '<button class="btn" data-act="cal-resync">Re-sync Google Calendar</button>' : ''}</div>
      <div class="banner info"><span>${sync}</span></div>
      <div class="toolbar">
        <div class="seg"><button type="button" data-act="cal-nav" data-dir="-1" aria-label="Previous">‹</button><button type="button" data-act="cal-nav" data-dir="0">Today</button><button type="button" data-act="cal-nav" data-dir="1" aria-label="Next">›</button></div>
        <b class="ctitle">${esc(title)}</b>
        <span class="grow"></span>
        ${opts.length > 1 ? `<select data-cal="who" aria-label="Whose calendar">${opts.map((o) => `<option value="${esc(o.value)}"${o.value === c.who ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>` : ''}
        <select data-cal="section" aria-label="Section"><option value="all">All sections</option>${secs.map((s) => `<option value="${esc(s.id)}"${s.id === c.section ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
        <div class="seg" role="group" aria-label="View">${['month', 'week', 'agenda'].map((v) => `<button type="button" class="${c.view === v ? 'on' : ''}" data-act="cal-view" data-v="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
      </div>
      <div class="clegend">${secs.map((s) => `<span><i style="--h:${hue(s.id)}"></i>${esc(s.name)}</span>`).join('')}<span><i class="lg-late"></i>Late</span><span><i class="lg-done"></i>Done</span></div>
      ${body}`;
  }

  function kpi(value, label, sub, cls) {
    return `<div class="kpi"><div class="v ${cls || ''}">${value}</div><div class="l">${label}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
  }

  // ------------------------------------------------------------ dashboard

  /** What the dashboard shows, shared by the page and its export. */
  function dashData() {
    const secs = liveSections().filter(hasSectionAccess);
    const assigned = S.items.filter((it) => { const s = sectionOf(it); return s && !s.archived && involved(it) && !isDone(s, it); }).sort(byDue);
    const pool = new Map();
    secs.forEach((s) => S.items.filter((it) => it.sectionId === s.id).forEach((it) => pool.set(it.id, it)));
    assigned.forEach((it) => pool.set(it.id, it));
    const attention = [];
    pool.forEach((it) => {
      const s = sectionOf(it);
      if (isDone(s, it)) return;
      const d = dueInfo(s, it);
      const a = ageInfo(s, it);
      const worst = [d, a].filter((x) => x && x.sev >= 1).sort((x, y) => y.sev - x.sev)[0];
      if (worst) attention.push({ it, s, info: worst, other: worst === d ? a : d });
    });
    attention.sort((x, y) => y.info.sev - x.info.sev || (involved(y.it) ? 1 : 0) - (involved(x.it) ? 1 : 0));
    const cards = secs.map((s) => {
      const its = S.items.filter((it) => it.sectionId === s.id);
      const open = its.filter((it) => !isDone(s, it));
      return {
        s, its, open,
        late: open.filter((it) => { const d = dueInfo(s, it); return d && d.sev === 2; }).length,
        stuck: open.filter((it) => ageInfo(s, it)).length,
        totals: s.fields.filter((f) => f.total).map((f) => ({ f, open: sum(open, (it) => val(it, f)), all: sum(its, (it) => val(it, f)) })),
      };
    });
    return { secs, assigned, attention, cards };
  }
  const canExportDash = () => S.me.isSuper || managed().length > 0;

  function viewDashboard() {
    const { secs, assigned, attention } = dashData();
    const crit = attention.filter((a) => a.info.sev === 2).length;
    const shown = attention.slice(0, 12);
    const hour = new Date().getHours();

    if (!S.sections.length) {
      return `<div class="head"><div><h1>Welcome, ${esc(S.me.name || '')}</h1></div></div>` + (S.me.isSuper
        ? `<div class="empty-state"><b>No sections yet</b>Start with the standard ones (Client RFQ Register, Supplier Register, Supplier RFQ / Quotations, Quotation Comparison, Proposal Submission, Technical Clarifications, Award / Result) and adjust their columns afterwards.<div style="margin-top:14px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap"><button class="btn primary" data-act="seed-sections">Create the standard sections</button><a class="btn" href="#sections">Start from scratch</a></div></div>`
        : '<div class="empty-state"><b>Nothing shared with you yet</b>The super admin has not given your account access to any section. Ask them to add you.</div>');
    }

    const cards = secs.map((s) => {
      const its = S.items.filter((it) => it.sectionId === s.id);
      const open = its.filter((it) => !isDone(s, it));
      const late = open.filter((it) => { const d = dueInfo(s, it); return d && d.sev === 2; }).length;
      const stuck = open.filter((it) => { const a = ageInfo(s, it); return a; }).length;
      const sf = stageF(s);
      const totals = s.fields.filter((f) => f.total).slice(0, 2);
      const segs = sf ? sf.options.map((o) => ({ o, n: its.filter((it) => val(it, sf) === o.value).length })).filter((x) => x.n) : [];
      return `<a class="scard" href="#s/${esc(s.id)}">
        <div class="sc-h">${secMark(s)}<b>${esc(s.name)}</b><span class="chip">${LEVEL_LABEL[myLevel(s)]}</span></div>
        <div class="sc-n">${kpi(open.length, 'Open', its.length + ' in total')}${kpi(late, 'Late', 'past due date', late ? 'crit' : '')}${kpi(stuck, 'Waiting', 'too long in a stage', stuck ? 'warn' : '')}</div>
        ${totals.length ? `<div class="sc-t">${totals.map((f) => `<span>${esc(f.label)} <b>${moneyShortOrNum(f, sum(open, (it) => val(it, f)))}</b> open</span>`).join('')}</div>` : ''}
        ${segs.length ? `<div class="segbar" title="Items by ${esc(sf.label)}">${segs.map((x) => `<i class="f-${x.o.color}" style="flex:${x.n}" title="${esc(x.o.label)}: ${x.n}"></i>`).join('')}</div>
          <div class="seglegend">${segs.slice(0, 6).map((x) => `<span><i class="f-${x.o.color}"></i>${esc(x.o.label)} ${x.n}</span>`).join('')}${segs.length > 6 ? `<span>+${segs.length - 6} more</span>` : ''}</div>` : ''}
      </a>`;
    }).join('');

    return `
      <div class="head"><div><h1>Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, ${esc((S.me.name || '').split(' ')[0] || 'there')}</h1>
        <div class="sub">${fmtDate(today())} · ${secs.length} section${secs.length === 1 ? '' : 's'} shared with you · ${crit} urgent, ${attention.length - crit} to watch</div></div>
        ${canExportDash() ? '<button class="btn" data-act="dash-export">Export dashboard</button>' : ''}</div>
      ${secs.length ? `<div class="scards">${cards}</div>` : `<div class="empty-state"><b>No section access</b>You can still see the items you are assigned to under My Work.</div>`}
      <div class="grid2">
        <section class="panel">
          <div class="ph"><h2>Needs attention</h2><span class="muted">${attention.length} item${attention.length === 1 ? '' : 's'}</span></div>
          ${shown.length ? `<ul class="alerts">${shown.map((a) => `
            <li data-act="open" data-id="${esc(a.it.id)}"><span class="sev ${a.info.cls}"></span>
              <div style="min-width:0"><div class="at">${esc(a.it.title)}</div><div class="am">${esc(a.s.name)} · ${esc(a.info.text)}${a.other ? ' · ' + esc(a.other.text) : ''}</div></div>
              ${avatars(a.it.editors || [], 2)}</li>`).join('')}</ul>${attention.length > shown.length ? `<div class="muted">and ${attention.length - shown.length} more</div>` : ''}`
          : '<div class="empty">Nothing late or waiting too long.</div>'}
        </section>
        <section class="panel">
          <div class="ph"><h2>My open work</h2><a href="#mywork">See all</a></div>
          ${assigned.length ? `<ul class="alerts">${assigned.slice(0, 8).map((it) => { const s = sectionOf(it); const d = dueInfo(s, it); return `
            <li data-act="open" data-id="${esc(it.id)}"><span class="sev ${d && d.sev ? d.cls : 'none'}"></span>
              <div style="min-width:0"><div class="at">${esc(it.title)}</div><div class="am">${esc(s.name)} · ${esc(roleOn(it))}</div></div>${chip(d)}</li>`; }).join('')}</ul>`
          : '<div class="empty">Nothing assigned to you right now.</div>'}
        </section>
      </div>`;
  }
  function moneyShortOrNum(f, n) { return f.type === 'currency' ? moneyShort(n) : nf.format(n); }
  function dueValue(it) { const s = sectionOf(it); const f = s && dueF(s); return (f && val(it, f)) || '9999'; }
  function byDue(a, b) { return dueValue(a).localeCompare(dueValue(b)); }

  // ------------------------------------------------------------ section

  // ---- filter & sort (per person, per section; remembered in this browser)

  const EXTRA_COLS = [
    { key: '_editors', label: 'Editors', type: 'people' },
    { key: '_collaborators', label: 'Collaborators', type: 'people' },
    { key: '_updated', label: 'Last updated', type: 'datetime' },
    { key: '_created', label: 'Created', type: 'datetime' },
  ];
  const OPS = {
    text: [['contains', 'contains'], ['not_contains', 'does not contain'], ['is', 'is exactly'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
    number: [['eq', '='], ['gt', '>'], ['lt', '<'], ['gte', '≥'], ['lte', '≤'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
    date: [['on', 'is on'], ['before', 'is before'], ['after', 'is after'], ['overdue', 'is overdue'], ['today', 'is today'], ['next7', 'is in the next 7 days'], ['this_month', 'is this month'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
    select: [['is', 'is'], ['is_not', 'is not'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
    person: [['is', 'is'], ['is_not', 'is not'], ['is_me', 'is me'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
    people: [['has', 'includes'], ['has_me', 'includes me'], ['empty', 'is empty']],
    checkbox: [['checked', 'is ticked'], ['unchecked', 'is not ticked']],
    link: [['is', 'is'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  };
  const NO_VALUE = ['empty', 'not_empty', 'overdue', 'today', 'next7', 'this_month', 'is_me', 'has_me', 'checked', 'unchecked'];
  const opGroup = (type) => ({ longtext: 'text', url: 'text', currency: 'number', percent: 'number', datetime: 'date' }[type] || type);

  let secf = {};
  try { secf = JSON.parse(localStorage.getItem('sourcinghub_filters') || '{}') || {}; } catch (e) { /* storage blocked */ }
  function fstate(sid) { if (!secf[sid]) secf[sid] = { rules: [], sort: { key: '', dir: 'asc' }, open: false }; return secf[sid]; }
  function saveF() { try { localStorage.setItem('sourcinghub_filters', JSON.stringify(secf)); } catch (e) { /* blocked */ } }
  const colsFor = (s) => s.fields.concat(EXTRA_COLS);
  const colOf = (s, key) => colsFor(s).find((f) => f.key === key);
  function fv(it, f) {
    if (f.key === '_editors') return it.editors || [];
    if (f.key === '_collaborators') return it.collaborators || [];
    if (f.key === '_updated') return it.updatedAt || '';
    if (f.key === '_created') return it.createdAt || '';
    return val(it, f);
  }
  function dayKey(v) {
    if (!v) return '';
    return /Z$|[+-]\d\d:\d\d$/.test(v) || v.length > 16 ? dayStr(new Date(v)) : v.slice(0, 10);
  }

  function matches(s, it, r) {
    const f = colOf(s, r.key);
    if (!f) return true;
    const v = fv(it, f);
    const g = opGroup(f.type);
    const isEmpty = Array.isArray(v) ? !v.length : blank(v) || v === false;
    if (r.op === 'empty') return isEmpty;
    if (r.op === 'not_empty') return !isEmpty;
    switch (g) {
      case 'text': {
        const a = String(v || '').toLowerCase();
        const b = String(r.value || '').toLowerCase();
        if (r.op === 'contains') return a.includes(b);
        if (r.op === 'not_contains') return !a.includes(b);
        return a === b;
      }
      case 'number': {
        if (isEmpty || blank(r.value)) return r.op !== 'eq' || blank(r.value);
        const a = Number(v);
        const b = Number(r.value);
        return { eq: a === b, gt: a > b, lt: a < b, gte: a >= b, lte: a <= b }[r.op];
      }
      case 'date': {
        if (isEmpty) return false;
        const d = dayKey(v);
        const t = today();
        if (r.op === 'on') return !r.value || d === r.value;
        if (r.op === 'before') return !r.value || d < r.value;
        if (r.op === 'after') return !r.value || d > r.value;
        if (r.op === 'today') return d === t;
        if (r.op === 'next7') { const n = daysFromToday(d); return n >= 0 && n <= 7; }
        if (r.op === 'this_month') return d.slice(0, 7) === t.slice(0, 7);
        if (r.op === 'overdue') {
          if (isDone(s, it)) return false;
          return f.type === 'datetime' && !f.key.startsWith('_') ? hoursUntil(v) < 0 : d < t;
        }
        return true;
      }
      case 'select': case 'person': case 'link':
        if (r.op === 'is_me') return v === S.me.id;
        if (r.op === 'is_not') return v !== r.value;
        return !r.value || v === r.value;
      case 'people':
        if (r.op === 'has_me') return v.includes(S.me.id);
        return !r.value || v.includes(r.value);
      case 'checkbox':
        return r.op === 'checked' ? !!v : !v;
      default:
        return true;
    }
  }

  function sortKey(s, it, f) {
    const v = fv(it, f);
    switch (opGroup(f.type)) {
      case 'number': return blank(v) ? null : Number(v);
      case 'date': return v ? (f.key.startsWith('_') ? v : String(v)) : null;
      case 'select': { const i = (f.options || []).findIndex((o) => o.value === v); return i < 0 ? null : i; }
      case 'person': return v ? userName(v).toLowerCase() : null;
      case 'people': return v.length ? v.length : null;
      case 'link': { const t = v && item(v); return t ? t.title.toLowerCase() : null; }
      case 'checkbox': return v ? 0 : 1;
      default: return blank(v) ? null : String(v).toLowerCase();
    }
  }

  function sorter(s) {
    const st = fstate(s.id).sort;
    const f = st.key && colOf(s, st.key);
    if (!f) return byDue;
    const dir = st.dir === 'desc' ? -1 : 1;
    return (a, b) => {
      const x = sortKey(s, a, f);
      const y = sortKey(s, b, f);
      if (x === null && y === null) return 0;
      if (x === null) return 1; // empty values always last
      if (y === null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    };
  }

  function sectionFilter(s) {
    const q = S.f.q.toLowerCase();
    const rules = fstate(s.id).rules;
    return S.items.filter((it) => it.sectionId === s.id &&
      (S.f.who !== 'mine' || involved(it)) &&
      (!q || [it.title].concat(s.fields.filter((f) => ['text', 'longtext', 'url'].includes(f.type)).map((f) => val(it, f))).join(' ').toLowerCase().includes(q)) &&
      rules.every((r) => matches(s, it, r)));
  }

  function filterPanel(s) {
    const st = fstate(s.id);
    if (!st.open && !st.rules.length) return '';
    const cols = colsFor(s);
    const valueInput = (r, i, f) => {
      const g = opGroup(f.type);
      const a = `data-fr="${i}" data-p="value" aria-label="Value"`;
      if (NO_VALUE.includes(r.op)) return '';
      if (g === 'text') return `<input type="text" ${a} value="${esc(r.value || '')}" placeholder="Type a value">`;
      if (g === 'number') return `<input type="number" step="any" ${a} value="${esc(r.value || '')}">`;
      if (g === 'date') return `<input type="date" ${a} value="${esc(r.value || '')}">`;
      if (g === 'select') return `<select ${a}><option value="">Choose…</option>${(f.options || []).map((o) => `<option value="${esc(o.value)}"${o.value === r.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
      if (g === 'person' || g === 'people') return `<select ${a}><option value="">Choose…</option>${S.users.map((u) => `<option value="${esc(u.id)}"${u.id === r.value ? ' selected' : ''}>${esc(u.name || u.id)}</option>`).join('')}</select>`;
      if (g === 'link') return `<select ${a}><option value="">Choose…</option>${S.items.filter((x) => x.sectionId === f.target).map((x) => `<option value="${esc(x.id)}"${x.id === r.value ? ' selected' : ''}>${esc(x.title)}</option>`).join('')}</select>`;
      return '';
    };
    return `<div class="fpanel">
      ${st.rules.map((r, i) => {
        const f = colOf(s, r.key) || cols[0];
        return `<div class="frule"><span class="fw">${i ? 'and' : 'Where'}</span>
          <select data-fr="${i}" data-p="key" aria-label="Column">${cols.map((c) => `<option value="${esc(c.key)}"${c.key === f.key ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select>
          <select data-fr="${i}" data-p="op" aria-label="Condition">${OPS[opGroup(f.type)].map(([k, l]) => `<option value="${k}"${k === r.op ? ' selected' : ''}>${l}</option>`).join('')}</select>
          ${valueInput(r, i, f)}
          <button type="button" class="ibtn" data-act="fr-del" data-i="${i}" aria-label="Remove filter">×</button></div>`;
      }).join('')}
      <div class="frow"><button type="button" class="btn sm" data-act="fr-add">+ Add filter</button>${st.rules.length ? '<button type="button" class="linkbtn" data-act="fr-clear">Clear all filters</button>' : '<span class="muted">Add a filter to narrow the list, for example Stage is Pending.</span>'}</div>
    </div>`;
  }

  function sortControls(s) {
    const st = fstate(s.id).sort;
    return `<label class="sortbox"><span>Sort</span><select data-sort="${esc(s.id)}" aria-label="Sort by"><option value="">Deadline (default)</option>${colsFor(s).map((c) => `<option value="${esc(c.key)}"${c.key === st.key ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select>
      <button type="button" class="ibtn" data-act="sort-dir" data-section="${esc(s.id)}" title="${st.dir === 'desc' ? 'Descending' : 'Ascending'}" aria-label="Sort direction: ${st.dir === 'desc' ? 'descending' : 'ascending'}"${st.key ? '' : ' disabled'}>${st.dir === 'desc' ? '↓' : '↑'}</button></label>`;
  }

  // ---- export report (Excel / PDF) of what the section shows now

  const LIBS = {
    xlsx: ['https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'],
    pdf: ['https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'],
  };
  const loadedLibs = {};
  function loadScript(src) {
    if (!loadedLibs[src]) {
      loadedLibs[src] = new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = resolve;
        el.onerror = () => { delete loadedLibs[src]; reject(new Error('Could not load the report tool. Check your internet connection and try again.')); };
        document.head.appendChild(el);
      });
    }
    return loadedLibs[src];
  }

  function reportData(s) {
    const list = sectionFilter(s).sort(sorter(s));
    const cols = s.fields.concat([
      { key: '_editors', label: 'Editors', type: 'people' },
      { key: '_collaborators', label: 'Collaborators', type: 'people' },
      { key: '_alerts', label: 'Alerts', type: 'text' },
      { key: '_updated', label: 'Last updated', type: 'datetime' },
    ]);
    // Excel serial number from local date parts (avoids the seconds drift of JS Date conversion)
    const serial = (d) => (d ? Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()) / 864e5 + 25569 : '');
    const cell = (it, f, excel) => {
      if (f.key === '_alerts') return [dueInfo(s, it), ageInfo(s, it)].filter((x) => x && x.sev >= 1).map((x) => x.text).join('; ');
      const v = fv(it, f);
      if (f.type === 'people') return v.map(userName).join(', ');
      if (blank(v) || v === false) return '';
      switch (f.type) {
        case 'number': case 'currency': return excel ? Number(v) : f.type === 'currency' ? money(v) : nf.format(v);
        case 'percent': return excel ? Number(v) / 100 : nf.format(v) + '%';
        case 'date': return excel ? serial(parseDay(v)) : fmtDate(v);
        case 'datetime': return excel ? serial(parseDT(v)) : f.key.startsWith('_') ? fmtDate(v) + ' ' + new Date(v).toTimeString().slice(0, 5) : fmtDT(v);
        case 'select': { const o = optOf(f, v); return o ? o.label : ''; }
        case 'person': return userName(v);
        case 'checkbox': return 'Yes';
        case 'link': { const t = item(v); return t ? t.title : ''; }
        default: return String(v);
      }
    };
    const rules = fstate(s.id).rules.map((r) => {
      const f = colOf(s, r.key);
      if (!f) return '';
      const opLabel = (OPS[opGroup(f.type)].find((o) => o[0] === r.op) || [, r.op])[1];
      let v = r.value;
      if (v && f.type === 'select') v = (optOf(f, v) || {}).label || v;
      if (v && (f.type === 'person' || f.type === 'people')) v = userName(v);
      if (v && f.type === 'link') v = (item(v) || {}).title || v;
      return f.label + ' ' + opLabel + (NO_VALUE.includes(r.op) || !v ? '' : ' ' + v);
    }).filter(Boolean);
    if (S.f.q) rules.unshift('Search “' + S.f.q + '”');
    if (S.f.who === 'mine') rules.unshift('Only my items');
    const sf = stageF(s);
    const byStage = sf ? sf.options.map((o) => ({ label: o.label, items: list.filter((it) => val(it, sf) === o.value) })).filter((x) => x.items.length) : [];
    const totals = s.fields.filter((f) => f.total);
    const st = fstate(s.id).sort;
    const sortCol = st.key && colOf(s, st.key);
    return {
      list, cols, cell, rules, byStage, totals, sf,
      sortText: sortCol ? sortCol.label + (st.dir === 'desc' ? ' (descending)' : ' (ascending)') : 'Deadline',
      when: new Date(),
      title: s.name + ' report',
      file: (s.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'Section') + '_' + today(),
    };
  }

  async function exportReport(s, fmt, btn) {
    if (!s || !can.report(ctx(), s)) { toast('Only this section’s managers and super admins can export reports.', true); return; }
    const r = reportData(s);
    if (!r.list.length) { toast('Nothing to export. Clear the search or filters first.', true); return; }
    const label = btn.querySelector('b').textContent;
    btn.disabled = true;
    btn.querySelector('b').textContent = 'Preparing…';
    try {
      for (const src of LIBS[fmt]) await loadScript(src);
      if (fmt === 'xlsx') exportXlsx(s, r); else exportPdf(s, r);
      toast('Report downloaded');
      const menu = btn.closest('details');
      if (menu) menu.open = false;
    } catch (e) {
      toast(e.message || 'Could not create the report.', true);
    } finally {
      btn.disabled = false;
      btn.querySelector('b').textContent = label;
    }
  }

  function exportXlsx(s, r) {
    const XL = window.XLSX;
    const header = r.cols.map((f) => f.label);
    const rows = r.list.map((it) => r.cols.map((f) => r.cell(it, f, true)));
    const ws = XL.utils.aoa_to_sheet([header].concat(rows));
    // Number formats by column type
    r.cols.forEach((f, c) => {
      const fmt = { currency: '#,##0.00', number: '#,##0.##', percent: '0%', date: 'd mmm yyyy', datetime: 'd mmm yyyy hh:mm' }[f.type];
      if (!fmt) return;
      for (let i = 1; i <= rows.length; i++) {
        const ref = XL.utils.encode_cell({ r: i, c });
        if (ws[ref] && ws[ref].v !== '') ws[ref].z = fmt;
      }
    });
    if (r.totals.length) {
      const totalRow = r.cols.map((f, c) => (c === 0 ? 'Total' : f.total ? sum(r.list, (it) => val(it, f)) : ''));
      XL.utils.sheet_add_aoa(ws, [totalRow], { origin: { r: rows.length + 1, c: 0 } });
      r.cols.forEach((f, c) => { if (f.total) ws[XL.utils.encode_cell({ r: rows.length + 1, c })].z = '#,##0.00'; });
    }
    ws['!cols'] = r.cols.map((f, c) => ({ wch: Math.min(f.type === 'longtext' ? 60 : 40, Math.max(10, f.label.length + 2, ...rows.slice(0, 200).map((row) => (['date', 'datetime'].includes(f.type) ? 18 : String(row[c] || '').length + 2)))) }));
    ws['!autofilter'] = { ref: XL.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: r.cols.length - 1 } }) };

    const summary = [
      [r.title],
      ['Generated', r.when.toLocaleString('en-MY'), 'by ' + (S.me.name || S.me.id)],
      ['Items', r.list.length],
      ['Filters', r.rules.length ? r.rules.join('; ') : 'None (all items you can see)'],
      ['Sorted by', r.sortText],
      [],
    ];
    if (r.byStage.length) {
      summary.push([r.sf.label, 'Items'].concat(r.totals.map((f) => f.label + ' (' + CUR + ')')));
      r.byStage.forEach((g) => summary.push([g.label, g.items.length].concat(r.totals.map((f) => sum(g.items, (it) => val(it, f))))));
      summary.push(['Total', r.list.length].concat(r.totals.map((f) => sum(r.list, (it) => val(it, f)))));
    } else if (r.totals.length) {
      r.totals.forEach((f) => summary.push([f.label + ' (' + CUR + ')', sum(r.list, (it) => val(it, f))]));
    }
    const ws2 = XL.utils.aoa_to_sheet(summary);
    ws2['!cols'] = [{ wch: 26 }, { wch: 22 }].concat(r.totals.map(() => ({ wch: 20 })));
    Object.keys(ws2).forEach((ref) => { if (ref[0] !== '!' && typeof ws2[ref].v === 'number' && ws2[ref].v >= 1000) ws2[ref].z = '#,##0.00'; });

    const wb = XL.utils.book_new();
    XL.utils.book_append_sheet(wb, ws, 'Items');
    XL.utils.book_append_sheet(wb, ws2, 'Summary');
    XL.writeFile(wb, r.file + '.xlsx');
  }

  function exportPdf(s, r) {
    const cols = r.cols.filter((f) => f.type !== 'longtext' && f.key !== '_collaborators');
    const body = r.list.map((it) => cols.map((f) => r.cell(it, f, false)));
    const allText = [r.title, ...r.rules].concat(...body).join(' ');
    // The built-in PDF fonts only cover Latin text. For Chinese and other scripts, use the browser's own PDF printer.
    if (/[^\u0000-ɏ -⁯₠-⃏←-⇿✓]/.test(allText)) { printReport(r, cols, body); return; }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const ink = [24, 34, 42];
    const muted = [117, 129, 138];
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(...ink);
    doc.text(r.title, 36, 42);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...muted);
    const meta = [
      'Generated ' + r.when.toLocaleString('en-MY') + ' by ' + (S.me.name || S.me.id) + ' · ' + r.list.length + ' item' + (r.list.length === 1 ? '' : 's') + ' · sorted by ' + r.sortText,
      'Filters: ' + (r.rules.length ? r.rules.join('; ') : 'none (all items you can see)'),
    ];
    let y = 58;
    meta.forEach((line) => { doc.splitTextToSize(line, W - 72).forEach((l) => { doc.text(l, 36, y); y += 12; }); });

    if (r.byStage.length || r.totals.length) {
      const head = [[r.sf ? r.sf.label : 'Group', 'Items'].concat(r.totals.map((f) => f.label))];
      const rows = (r.byStage.length ? r.byStage : [{ label: 'All', items: r.list }]).map((g) => [g.label, g.items.length].concat(r.totals.map((f) => money(sum(g.items, (it) => val(it, f))))));
      if (r.byStage.length > 1) rows.push(['Total', r.list.length].concat(r.totals.map((f) => money(sum(r.list, (it) => val(it, f))))));
      doc.autoTable({
        head, body: rows, startY: y + 4, margin: { left: 36, right: 36 }, tableWidth: 'wrap',
        styles: { fontSize: 8, cellPadding: 3, textColor: ink }, headStyles: { fillColor: [235, 229, 245], textColor: ink, fontStyle: 'bold' },
        columnStyles: Object.fromEntries(r.totals.map((f, i) => [i + 2, { halign: 'right' }]).concat([[1, { halign: 'right' }]])),
        didParseCell: (d) => { if (d.section === 'body' && d.row.raw[0] === 'Total') d.cell.styles.fontStyle = 'bold'; },
      });
      y = doc.lastAutoTable.finalY + 14;
    }

    const right = Object.fromEntries(cols.map((f, i) => [i, ['currency', 'number', 'percent'].includes(f.type) ? { halign: 'right' } : f.key === 'title' ? { cellWidth: 150, fontStyle: 'bold' } : {}]));
    const foot = r.totals.length ? [cols.map((f, i) => (i === 0 ? 'Total' : f.total ? money(sum(r.list, (it) => val(it, f))) : ''))] : undefined;
    doc.autoTable({
      head: [cols.map((f) => f.label)], body, foot, startY: y, margin: { left: 36, right: 36, bottom: 36 },
      styles: { fontSize: cols.length > 12 ? 6.5 : 7.5, cellPadding: 3, overflow: 'linebreak', textColor: ink, lineColor: [224, 228, 226], lineWidth: 0.5 },
      headStyles: { fillColor: [180, 82, 15], textColor: 255, fontStyle: 'bold' },
      footStyles: { fillColor: [247, 248, 247], textColor: ink, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [250, 251, 250] },
      columnStyles: right,
      showFoot: 'lastPage',
      didParseCell: (d) => {
        if (d.section === 'body' && cols[d.column.index].key === '_alerts' && d.cell.raw) d.cell.styles.textColor = [177, 39, 31];
      },
    });
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFontSize(8);
      doc.setTextColor(...muted);
      doc.text('Sourcing Hub · ' + s.name, 36, doc.internal.pageSize.getHeight() - 18);
      doc.text('Page ' + p + ' of ' + pages, W - 36, doc.internal.pageSize.getHeight() - 18, { align: 'right' });
    }
    doc.save(r.file + '.pdf');
  }

  /** Report as a print-ready page for text the PDF fonts cannot draw (e.g. Chinese). The browser saves it as PDF. */
  function printReport(r, cols, body) {
    const w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups for this site to create the PDF.', true); return; }
    const tot = (f, items) => money(sum(items, (it) => val(it, f)));
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.file)}</title>
      <style>@page{size:A4 landscape;margin:12mm}body{font:10px/1.4 "Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;color:#18222a;margin:0}
      h1{font-size:18px;margin:0 0 4px}p{margin:0 0 3px;color:#5d6a73}table{border-collapse:collapse;width:100%;margin-top:10px}
      th{background:#a3235a;color:#fff;text-align:left;padding:4px 5px}td{border-bottom:1px solid #e0e4e2;padding:4px 5px;vertical-align:top}
      .r{text-align:right}.sum{width:auto}.sum th{background:#fbe4ee;color:#18222a}tfoot td{font-weight:bold;background:#f7f8f7}thead{display:table-header-group}tr{page-break-inside:avoid}</style></head><body>
      <h1>${esc(r.title)}</h1>
      <p>Generated ${esc(r.when.toLocaleString('en-MY'))} by ${esc(S.me.name || S.me.id)} · ${r.list.length} items · sorted by ${esc(r.sortText)}</p>
      <p>Filters: ${esc(r.rules.length ? r.rules.join('; ') : 'none (all items you can see)')}</p>
      ${r.byStage.length ? `<table class="sum"><thead><tr><th>${esc(r.sf.label)}</th><th class="r">Items</th>${r.totals.map((f) => `<th class="r">${esc(f.label)}</th>`).join('')}</tr></thead>
        <tbody>${r.byStage.map((g) => `<tr><td>${esc(g.label)}</td><td class="r">${g.items.length}</td>${r.totals.map((f) => `<td class="r">${tot(f, g.items)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : ''}
      <table><thead><tr>${cols.map((f) => `<th class="${['currency', 'number', 'percent'].includes(f.type) ? 'r' : ''}">${esc(f.label)}</th>`).join('')}</tr></thead>
      <tbody>${body.map((row) => `<tr>${row.map((c, i) => `<td class="${['currency', 'number', 'percent'].includes(cols[i].type) ? 'r' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
      ${r.totals.length ? `<tfoot><tr>${cols.map((f, i) => `<td class="r">${i === 0 ? 'Total' : f.total ? tot(f, r.list) : ''}</td>`).join('')}</tr></tfoot>` : ''}</table>
      <script>window.onload=function(){window.print();}<\/script></body></html>`);
    w.document.close();
  }

  // ---- generic multi-table report (team performance, dashboard)
  // table: { name, heading, cols: [{ label, kind: 'text'|'int'|'money'|'pct'|'date' }], rows: [[raw values]], total?: [raw values] }

  function fmtCell(kind, v) {
    if (blank(v)) return '';
    if (kind === 'money') return money(v);
    if (kind === 'int') return nf.format(v);
    if (kind === 'pct') return Math.round(v) + '%';
    if (kind === 'date') return fmtDate(v);
    return String(v);
  }
  function xlCell(kind, v) {
    if (blank(v)) return '';
    if (kind === 'pct') return Number(v) / 100;
    if (kind === 'date') { const d = parseDT(v); return d ? Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5 + 25569 : ''; }
    return v;
  }

  async function exportTables(fmt, rep, btn) {
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
    try {
      for (const src of LIBS[fmt]) await loadScript(src);
      if (fmt === 'xlsx') tablesXlsx(rep); else tablesPdf(rep);
      toast('Report downloaded');
      return true;
    } catch (e) {
      toast(e.message || 'Could not create the report.', true);
      return false;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  }

  function tablesXlsx(rep) {
    const XL = window.XLSX;
    const wb = XL.utils.book_new();
    const info = [[rep.title], ['Generated', new Date().toLocaleString('en-MY'), 'by ' + (S.me.name || S.me.id)]].concat(rep.meta.map((m) => [m]));
    info.push([], ['Contents']);
    rep.tables.forEach((t) => info.push([t.heading, t.rows.length + ' rows']));
    const wi = XL.utils.aoa_to_sheet(info);
    wi['!cols'] = [{ wch: 42 }, { wch: 24 }, { wch: 20 }];
    XL.utils.book_append_sheet(wb, wi, 'Report');
    const used = {};
    rep.tables.forEach((t) => {
      const data = [t.cols.map((c) => c.label)].concat(t.rows.map((r) => r.map((v, i) => xlCell(t.cols[i].kind, v))));
      if (t.total) data.push(t.total.map((v, i) => xlCell(t.cols[i].kind, v)));
      const ws = XL.utils.aoa_to_sheet(data);
      t.cols.forEach((c, ci) => {
        const z = { money: '#,##0.00', int: '#,##0', pct: '0%', date: 'd mmm yyyy' }[c.kind];
        if (!z) return;
        for (let ri = 1; ri < data.length; ri++) { const ref = XL.utils.encode_cell({ r: ri, c: ci }); if (ws[ref] && ws[ref].v !== '') ws[ref].z = z; }
      });
      ws['!cols'] = t.cols.map((c, ci) => ({ wch: Math.min(50, Math.max(10, c.label.length + 2, ...data.slice(1, 200).map((r) => (c.kind === 'date' ? 14 : String(r[ci] || '').length + 2)))) }));
      if (t.rows.length) ws['!autofilter'] = { ref: XL.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: t.rows.length, c: t.cols.length - 1 } }) };
      let name = t.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || 'Sheet';
      while (used[name]) name = name.slice(0, 26) + ' ' + (used[name] += 1);
      used[name] = 1;
      XL.utils.book_append_sheet(wb, ws, name);
    });
    XL.writeFile(wb, rep.file + '.xlsx');
  }

  function tablesPdf(rep) {
    const bodies = rep.tables.map((t) => t.rows.map((r) => r.map((v, i) => fmtCell(t.cols[i].kind, v))));
    const allText = [rep.title].concat(rep.meta, ...bodies.flat(), ...rep.tables.map((t) => t.heading)).join(' ');
    if (/[^\u0000-ɏ -⁯₠-⃏←-⇿✓]/.test(allText)) { printTables(rep, bodies); return; }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const ink = [24, 34, 42];
    const muted = [117, 129, 138];
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(...ink);
    doc.text(rep.title, 36, 42);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...muted);
    let y = 58;
    ['Generated ' + new Date().toLocaleString('en-MY') + ' by ' + (S.me.name || S.me.id)].concat(rep.meta).forEach((line) => {
      doc.splitTextToSize(line, W - 72).forEach((l) => { doc.text(l, 36, y); y += 12; });
    });
    rep.tables.forEach((t, ti) => {
      if (y > H - 90) { doc.addPage(); y = 42; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...ink);
      doc.text(t.heading + '  (' + t.rows.length + ')', 36, y + 10);
      doc.setFont('helvetica', 'normal');
      const align = Object.fromEntries(t.cols.map((c, i) => [i, ['money', 'int', 'pct'].includes(c.kind) ? { halign: 'right' } : {}]));
      doc.autoTable({
        head: [t.cols.map((c) => c.label)],
        body: bodies[ti].length ? bodies[ti] : [[{ content: 'Nothing to show', colSpan: t.cols.length, styles: { textColor: muted } }]],
        foot: t.total ? [t.total.map((v, i) => fmtCell(t.cols[i].kind, v))] : undefined,
        startY: y + 16, margin: { left: 36, right: 36, bottom: 36 }, showFoot: 'lastPage',
        styles: { fontSize: t.cols.length > 10 ? 7 : 8, cellPadding: 3, overflow: 'linebreak', textColor: ink, lineColor: [224, 228, 226], lineWidth: 0.5 },
        headStyles: { fillColor: [180, 82, 15], textColor: 255, fontStyle: 'bold' },
        footStyles: { fillColor: [247, 248, 247], textColor: ink, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [250, 251, 250] },
        columnStyles: align,
      });
      y = doc.lastAutoTable.finalY + 22;
    });
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p); doc.setFontSize(8); doc.setTextColor(...muted);
      doc.text('Sourcing Hub · ' + rep.title, 36, H - 18);
      doc.text('Page ' + p + ' of ' + pages, W - 36, H - 18, { align: 'right' });
    }
    doc.save(rep.file + '.pdf');
  }

  function printTables(rep, bodies) {
    const w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups for this site to create the PDF.', true); return; }
    const r = (k) => (['money', 'int', 'pct'].includes(k) ? ' class="r"' : '');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(rep.file)}</title>
      <style>@page{size:A4 landscape;margin:12mm}body{font:10px/1.4 "Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;color:#18222a;margin:0}
      h1{font-size:18px;margin:0 0 4px}h2{font-size:13px;margin:16px 0 4px}p{margin:0 0 3px;color:#5d6a73}table{border-collapse:collapse;width:100%}
      th{background:#a3235a;color:#fff;text-align:left;padding:4px 5px}td{border-bottom:1px solid #e0e4e2;padding:4px 5px;vertical-align:top}
      .r{text-align:right}tfoot td{font-weight:bold;background:#f7f8f7}thead{display:table-header-group}tr{page-break-inside:avoid}</style></head><body>
      <h1>${esc(rep.title)}</h1><p>Generated ${esc(new Date().toLocaleString('en-MY'))} by ${esc(S.me.name || S.me.id)}</p>${rep.meta.map((m) => `<p>${esc(m)}</p>`).join('')}
      ${rep.tables.map((t, ti) => `<h2>${esc(t.heading)} (${t.rows.length})</h2><table><thead><tr>${t.cols.map((c) => `<th${r(c.kind)}>${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${bodies[ti].map((row) => `<tr>${row.map((v, i) => `<td${r(t.cols[i].kind)}>${esc(v)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${t.cols.length}">Nothing to show</td></tr>`}</tbody>
        ${t.total ? `<tfoot><tr>${t.total.map((v, i) => `<td${r(t.cols[i].kind)}>${esc(fmtCell(t.cols[i].kind, v))}</td>`).join('')}</tr></tfoot>` : ''}</table>`).join('')}
      <script>window.onload=function(){window.print();}<\/script></body></html>`);
    w.document.close();
  }

  // ---- team workload & performance

  const PERIODS = { 30: 'Last 30 days', month: 'This month', 90: 'Last 90 days', all: 'All time' };
  const canPerf = () => S.me.isSuper || managed().length > 0;

  function perfData() {
    const period = S.f.perf.period;
    const now = new Date();
    const from = period === 'all' ? null : period === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(Date.now() - Number(period) * 864e5);
    const inPeriod = (iso) => { const d = parseDT(iso); return d && (!from || d >= from); };
    const secs = S.me.isSuper ? liveSections() : liveSections().filter((s) => managed().includes(s.id));
    const secIds = secs.map((s) => s.id);
    const mon = Core.monitorable(ctx(), S.sections, S.items, S.users);
    const people = S.users.filter((u) => u.active !== false && (S.me.isSuper || mon[u.id]))
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    const scoped = S.items.filter((it) => secIds.includes(it.sectionId));
    const owns = (it, uid) => (it.editors || []).includes(uid) || sectionOf(it).fields.some((f) => f.type === 'person' && val(it, f) === uid);
    const rows = people.map((u) => {
      const mine = scoped.filter((it) => owns(it, u.id));
      const open = mine.filter((it) => !isDone(sectionOf(it), it));
      const late = open.filter((it) => { const d = dueInfo(sectionOf(it), it); return d && d.sev === 2; });
      const soon = open.filter((it) => { const s = sectionOf(it); const f = !dueMet(s, it) && dueF(s); const v = f && val(it, f); const n = v ? daysFromToday(v.slice(0, 10)) : null; return n !== null && n >= 0 && n <= 7; });
      const waiting = open.filter((it) => ageInfo(sectionOf(it), it));
      const done = mine.filter((it) => isDone(sectionOf(it), it) && inPeriod(it.stageChangedAt));
      const withDue = done.filter((it) => { const f = dueF(sectionOf(it)); return f && val(it, f); });
      const onTime = withDue.filter((it) => {
        const f = dueF(sectionOf(it));
        const v = val(it, f);
        const doneAt = parseDT(it.stageChangedAt);
        return f.type === 'datetime' ? doneAt <= parseDT(v) : dayStr(doneAt) <= v.slice(0, 10);
      });
      const days = done.map((it) => (parseDT(it.stageChangedAt) - parseDT(it.createdAt)) / 864e5).filter((d) => d >= 0);
      const collab = scoped.filter((it) => (it.collaborators || []).includes(u.id) && !isDone(sectionOf(it), it)).length;
      return {
        u, open, late, soon, waiting, done, collab,
        onTimePct: withDue.length ? (onTime.length / withDue.length) * 100 : null,
        avgDays: days.length ? days.reduce((a, b) => a + b, 0) / days.length : null,
        bySec: secs.map((s) => ({ s, n: open.filter((it) => it.sectionId === s.id).length })),
      };
    });
    return { rows, secs, period, scoped };
  }

  function viewPerformance() {
    if (!canPerf()) return '<div class="empty-state"><b>Managers and super admins only</b>This page shows workload for the sections you manage.</div>';
    const { rows, secs } = perfData();
    const sorted = rows.slice();
    const key = S.f.perf.sort;
    const val2 = (r) => ({ name: (r.u.name || r.u.id).toLowerCase(), open: -r.open.length, late: -r.late.length, done: -r.done.length, ontime: -(r.onTimePct === null ? -1 : r.onTimePct) }[key]);
    sorted.sort((a, b) => (val2(a) < val2(b) ? -1 : val2(a) > val2(b) ? 1 : 0));
    const maxOpen = Math.max(1, ...rows.map((r) => r.open.length));
    const tot = (f) => rows.reduce((t, r) => t + f(r), 0);
    const doneAll = tot((r) => r.done.length);
    const th = (k, label, cls) => `<th class="${cls || ''}"><button type="button" class="thsort${key === k ? ' on' : ''}" data-act="perf-sort" data-k="${k}">${label}${key === k ? ' ↓' : ''}</button></th>`;
    const status = (r) => {
      if (!r.open.length) return '<span class="chip">No open work</span>';
      const ratio = r.late.length / r.open.length;
      return ratio > 0.3 ? '<span class="chip crit">Behind</span>' : ratio > 0.1 || r.waiting.length ? '<span class="chip warn">Watch</span>' : '<span class="chip ok">On track</span>';
    };
    return `
      <div class="head"><div><h1>Team performance</h1>
        <div class="sub">${S.me.isSuper ? 'Everyone, across all sections' : 'People on the sections you manage: ' + esc(secs.map((s) => s.name).join(', '))} · open work counts items where the person is an editor or the named person</div></div>
        <div class="toolbar">
          <select data-perf="period" aria-label="Period">${Object.entries(PERIODS).map(([k, l]) => `<option value="${k}"${String(S.f.perf.period) === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <details class="menu"><summary class="btn">Export report</summary><div class="menu-b">
            <button type="button" data-act="perf-export" data-fmt="xlsx"><b>Excel (.xlsx)</b><small>Summary, per-section workload and late items</small></button>
            <button type="button" data-act="perf-export" data-fmt="pdf"><b>PDF</b><small>A4 landscape report</small></button></div></details>
        </div></div>
      <div class="scards perf-kpis">
        <div class="panel">${kpi(rows.length, 'People', secs.length + ' section' + (secs.length === 1 ? '' : 's'))}</div>
        <div class="panel">${kpi(tot((r) => r.open.length), 'Open items', tot((r) => r.soon.length) + ' due in 7 days')}</div>
        <div class="panel">${kpi(tot((r) => r.late.length), 'Late', 'past their deadline', tot((r) => r.late.length) ? 'crit' : '')}</div>
        <div class="panel">${kpi(doneAll, 'Completed', PERIODS[S.f.perf.period].toLowerCase())}</div>
      </div>
      ${rows.length ? `<div class="tablewrap"><table class="t perf">
        <thead><tr>${th('name', 'Person')}<th>Status</th>${th('open', 'Open', 'r')}${th('late', 'Late', 'r')}<th class="r">Due ≤ 7 days</th><th class="r">Waiting</th>${th('done', 'Completed', 'r')}${th('ontime', 'On time', 'r')}<th class="r">Avg days to finish</th><th class="r">Collaborating</th><th>Open work by section</th><th></th></tr></thead>
        <tbody>${sorted.map((r) => `<tr>
          <td class="nw"><span class="who">${avatar(r.u.id)}<span>${esc(r.u.name || r.u.id)}</span></span></td>
          <td>${status(r)}</td>
          <td class="r"><b>${r.open.length}</b></td>
          <td class="r">${r.late.length ? `<span style="color:var(--crit);font-weight:600">${r.late.length}</span>` : '0'}</td>
          <td class="r">${r.soon.length}</td><td class="r">${r.waiting.length}</td><td class="r">${r.done.length}</td>
          <td class="r">${r.onTimePct === null ? '<span class="muted">—</span>' : Math.round(r.onTimePct) + '%'}</td>
          <td class="r">${r.avgDays === null ? '<span class="muted">—</span>' : r.avgDays.toFixed(1)}</td>
          <td class="r">${r.collab}</td>
          <td style="min-width:180px"><div class="segbar" style="width:${Math.max(4, (r.open.length / maxOpen) * 100)}%">${r.bySec.filter((x) => x.n).map((x) => `<i style="flex:${x.n};background:hsl(${hue(x.s.id)} 45% 45%)" title="${esc(x.s.name)}: ${x.n}"></i>`).join('')}</div></td>
          <td class="nw"><button type="button" class="btn sm" data-act="perf-cal" data-id="${esc(r.u.id)}">Calendar</button></td>
        </tr>`).join('')}</tbody></table></div>
        <div class="clegend">${secs.map((s) => `<span><i style="--h:${hue(s.id)}"></i>${esc(s.name)}</span>`).join('')}</div>
        <p class="muted" style="font-size:12.5px;margin:0">Completed = moved to a done stage in the period. On time = completed on or before its deadline. Status: Behind when more than 30% of open work is late; Watch when some is late or waiting too long in a stage.</p>`
      : '<div class="empty-state"><b>No people to show</b>Give people access to the sections you manage, or name them on items.</div>'}`;
  }

  function perfReport() {
    const { rows, secs, period } = perfData();
    const late = [];
    rows.forEach((r) => r.late.forEach((it) => { const s = sectionOf(it); const f = dueF(s); late.push([r.u.name || r.u.id, it.title, s.name, (stageOpt(s, it) || {}).label || '', f ? val(it, f).slice(0, 10) : '', dueInfo(s, it).text]); }));
    return {
      title: 'Team performance',
      meta: ['Scope: ' + (S.me.isSuper ? 'everyone, all sections' : secs.map((s) => s.name).join(', ')), 'Period for completed work: ' + PERIODS[period]],
      file: 'Team_performance_' + today(),
      tables: [
        {
          name: 'Summary', heading: 'Workload and performance by person',
          cols: [{ label: 'Person', kind: 'text' }, { label: 'Open', kind: 'int' }, { label: 'Late', kind: 'int' }, { label: 'Due in 7 days', kind: 'int' }, { label: 'Waiting', kind: 'int' }, { label: 'Completed', kind: 'int' }, { label: 'On time', kind: 'pct' }, { label: 'Avg days to finish', kind: 'text' }, { label: 'Collaborating', kind: 'int' }],
          rows: rows.map((r) => [r.u.name || r.u.id, r.open.length, r.late.length, r.soon.length, r.waiting.length, r.done.length, r.onTimePct === null ? '' : Math.round(r.onTimePct), r.avgDays === null ? '' : r.avgDays.toFixed(1), r.collab]),
          total: ['Total', ...['open', 'late', 'soon', 'waiting', 'done'].map((k) => rows.reduce((t, r) => t + r[k].length, 0)), '', '', rows.reduce((t, r) => t + r.collab, 0)],
        },
        {
          name: 'By section', heading: 'Open work by section',
          cols: [{ label: 'Person', kind: 'text' }].concat(secs.map((s) => ({ label: s.name, kind: 'int' }))).concat([{ label: 'Total', kind: 'int' }]),
          rows: rows.map((r) => [r.u.name || r.u.id].concat(r.bySec.map((x) => x.n)).concat([r.open.length])),
        },
        {
          name: 'Late items', heading: 'Late items by person',
          cols: [{ label: 'Person', kind: 'text' }, { label: 'Item', kind: 'text' }, { label: 'Section', kind: 'text' }, { label: 'Stage', kind: 'text' }, { label: 'Deadline', kind: 'date' }, { label: 'Alert', kind: 'text' }],
          rows: late,
        },
      ],
    };
  }

  // ---- dashboard export (pick the displays to include)

  function dashTables() {
    const { attention, assigned, cards } = dashData();
    const t = {
      sections: {
        label: 'Section summary', hint: 'Open, late and waiting counts for each section you can open',
        table: () => ({
          name: 'Sections', heading: 'Section summary',
          cols: [{ label: 'Section', kind: 'text' }, { label: 'Your access', kind: 'text' }, { label: 'Open', kind: 'int' }, { label: 'Total', kind: 'int' }, { label: 'Late', kind: 'int' }, { label: 'Waiting', kind: 'int' }, { label: 'Open value', kind: 'text' }],
          rows: cards.map((c) => [c.s.name, LEVEL_LABEL[myLevel(c.s)], c.open.length, c.its.length, c.late, c.stuck, c.totals.map((x) => x.f.label + ': ' + moneyShortOrNum(x.f, x.open)).join('; ')]),
        }),
      },
      stages: {
        label: 'Items by stage', hint: 'How many items sit in each stage, per section',
        table: () => {
          const rows = [];
          cards.forEach((c) => { const sf = stageF(c.s); if (sf) sf.options.forEach((o) => { const n = c.its.filter((it) => val(it, sf) === o.value).length; if (n) rows.push([c.s.name, o.label, n]); }); });
          return { name: 'By stage', heading: 'Items by stage', cols: [{ label: 'Section', kind: 'text' }, { label: 'Stage', kind: 'text' }, { label: 'Items', kind: 'int' }], rows };
        },
      },
      attention: {
        label: 'Needs attention', hint: 'Everything late or waiting too long, most urgent first',
        table: () => ({
          name: 'Needs attention', heading: 'Needs attention',
          cols: [{ label: 'Item', kind: 'text' }, { label: 'Section', kind: 'text' }, { label: 'Alert', kind: 'text' }, { label: 'Also', kind: 'text' }, { label: 'Editors', kind: 'text' }],
          rows: attention.map((a) => [a.it.title, a.s.name, a.info.text, a.other ? a.other.text : '', (a.it.editors || []).map(userName).join(', ')]),
        }),
      },
      mywork: {
        label: 'My open work', hint: 'Items you are an editor, collaborator or named person on',
        table: () => ({
          name: 'My open work', heading: 'My open work',
          cols: [{ label: 'Item', kind: 'text' }, { label: 'Section', kind: 'text' }, { label: 'My role', kind: 'text' }, { label: 'Stage', kind: 'text' }, { label: 'Deadline', kind: 'date' }, { label: 'Alert', kind: 'text' }],
          rows: assigned.map((it) => { const s = sectionOf(it); const f = dueF(s); const d = dueInfo(s, it); return [it.title, s.name, roleOn(it), (stageOpt(s, it) || {}).label || '', f && val(it, f) ? val(it, f).slice(0, 10) : '', d && d.sev ? d.text : '']; }),
        }),
      },
    };
    if (canPerf()) t.team = { label: 'Team performance', hint: 'Workload and completion for the people you can monitor', table: () => perfReport().tables[0] };
    return t;
  }

  function openDashExport() {
    const t = dashTables();
    S.drawer = { kind: 'dash-export' };
    drawerEl.innerHTML = `
      <div class="scrim" data-act="close-drawer"></div>
      <div class="pane" role="dialog" aria-modal="true" aria-labelledby="paneTitle">
        <div class="pane-h"><div><div class="k">Dashboard</div><h2 id="paneTitle">Export dashboard</h2></div><button type="button" class="x" data-act="close-drawer" aria-label="Close">×</button></div>
        <div class="pane-b">
          <form id="dashExportForm" class="form" novalidate>
            <div class="fld wide"><span>Displays to include</span><div class="tpl-list">
              ${Object.entries(t).map(([k, x]) => `<label class="tpl"><input type="checkbox" name="part" value="${k}" checked><span><b>${esc(x.label)}</b><small>${esc(x.hint)}</small></span></label>`).join('')}
            </div></div>
            <div class="fld wide"><span>Format</span><div class="tpl-list">
              <label class="tpl"><input type="radio" name="fmt" value="xlsx" checked><span><b>Excel (.xlsx)</b><small>One sheet per display</small></span></label>
              <label class="tpl"><input type="radio" name="fmt" value="pdf"><span><b>PDF</b><small>A4 landscape, one table per display</small></span></label>
            </div></div>
            <div class="form-actions"><button type="submit" class="btn primary" id="saveBtn">Download report</button><button type="button" class="btn" data-act="close-drawer">Cancel</button></div>
          </form>
        </div>
      </div>`;
    openDrawer('#saveBtn');
  }

  async function runDashExport(form) {
    const parts = [...form.querySelectorAll('input[name=part]:checked')].map((x) => x.value);
    if (!parts.length) { toast('Tick at least one display.', true); return; }
    const fmt = form.querySelector('input[name=fmt]:checked').value;
    const t = dashTables();
    const rep = {
      title: 'Dashboard report',
      meta: ['Prepared for ' + (S.me.name || S.me.id) + ' · shows only the sections and items this account can open'],
      file: 'Dashboard_' + today(),
      tables: parts.map((k) => t[k].table()),
    };
    if (await exportTables(fmt, rep, $('#saveBtn'))) closeDrawer();
  }

  function refreshSection(panelToo) {
    const body = $('#secBody');
    if (!body) return;
    const s = section(body.dataset.section);
    if (panelToo) { const p = $('#filterPanel'); if (p) p.innerHTML = filterPanel(s); }
    const n = fstate(s.id).rules.length;
    const b = $('#frBtn');
    if (b) { b.textContent = n ? 'Filter · ' + n : 'Filter'; b.classList.toggle('on', n > 0 || fstate(s.id).open); }
    body.innerHTML = sectionBody(s);
  }

  function viewSection(id) {
    const s = section(id);
    if (!s || (s.archived && !S.me.isSuper)) return '<div class="empty-state"><b>Section not found</b>It may have been removed, or you no longer have access. <a href="#dashboard">Back to the dashboard</a></div>';
    const lvl = myLevel(s);
    const all = S.items.filter((it) => it.sectionId === s.id);
    const view = stageF(s) ? (S.f.view[s.id] || 'board') : 'table';
    return `
      ${s.archived ? '<div class="banner"><b>Removed section</b><span>Only you can see it. Restore it under Manage sections.</span></div>' : ''}
      <div class="head"><div><h1>${esc(s.name)}</h1>
        <div class="sub">${all.length} item${all.length === 1 ? '' : 's'}${hasSectionAccess(s) ? ` · your access: ${LEVEL_LABEL[lvl]}` : ' · you see only the items you are assigned to'}</div></div>
        <div class="toolbar">
          ${can.report(ctx(), s) ? `<details class="menu"><summary class="btn">Export report</summary>
            <div class="menu-b" role="menu">
              <button type="button" role="menuitem" data-act="export" data-fmt="xlsx" data-section="${esc(s.id)}"><b>Excel (.xlsx)</b><small>Every column, plus a summary sheet</small></button>
              <button type="button" role="menuitem" data-act="export" data-fmt="pdf" data-section="${esc(s.id)}"><b>PDF</b><small>Printable A4 landscape report</small></button>
              <p>Exports what is shown now: your search, filters and sort.</p>
            </div></details>` : ''}
          ${can.template(ctx(), s) ? `<a class="btn" href="#s/${esc(s.id)}/customize">Customize columns</a>` : ''}
          ${can.create(ctx(), s) ? `<button class="btn primary" data-act="new" data-section="${esc(s.id)}">+ New item</button>` : ''}
        </div></div>
      <div class="toolbar">
        <div class="grow"><input type="search" id="secQuery" placeholder="Search ${esc(s.name)}" value="${esc(S.f.q)}" data-filter-input="q" aria-label="Search"></div>
        <select id="secWho" data-filter="who" aria-label="Show"><option value="all">All items</option><option value="mine"${S.f.who === 'mine' ? ' selected' : ''}>Only mine</option></select>
        <button type="button" class="btn${fstate(s.id).rules.length || fstate(s.id).open ? ' on' : ''}" id="frBtn" data-act="fr-toggle">${fstate(s.id).rules.length ? 'Filter · ' + fstate(s.id).rules.length : 'Filter'}</button>
        ${sortControls(s)}
        ${stageF(s) ? `<div class="seg" role="group" aria-label="View"><button type="button" class="${view === 'board' ? 'on' : ''}" data-act="view" data-v="board" data-section="${esc(s.id)}">Board</button><button type="button" class="${view === 'table' ? 'on' : ''}" data-act="view" data-v="table" data-section="${esc(s.id)}">Table</button></div>` : ''}
      </div>
      <div id="filterPanel">${filterPanel(s)}</div>
      <div id="secBody" data-section="${esc(s.id)}">${sectionBody(s)}</div>`;
  }

  function sectionBody(s) {
    const list = sectionFilter(s);
    const all = S.items.filter((it) => it.sectionId === s.id);
    if (!all.length) return `<div class="empty-state"><b>No items yet</b>${can.create(ctx(), s) ? 'Add the first one with “+ New item”.' : 'Items appear here once someone adds them.'}</div>`;
    const totals = s.fields.filter((f) => f.total);
    const open = list.filter((it) => !isDone(s, it));
    const stat = `<div class="statline"><span><b>${list.length}</b> shown</span><span><b>${open.length}</b> open</span>
      ${totals.map((f) => `<span>${esc(f.label)} (open) <b>${moneyShortOrNum(f, sum(open, (it) => val(it, f)))}</b></span>`).join('')}</div>`;
    const view = stageF(s) ? (S.f.view[s.id] || 'board') : 'table';
    return stat + (view === 'board' ? board(s, list) : table(s, list));
  }

  function board(s, list) {
    const sf = stageF(s);
    const total = s.fields.find((f) => f.total);
    const cols = sf.options.map((o) => ({ value: o.value, label: o.label, color: o.color }));
    if (list.some((it) => !optOf(sf, val(it, sf)))) cols.push({ value: '', label: 'No ' + sf.label.toLowerCase(), color: 'gray' });
    return `<div class="board">${cols.map((c) => {
      const cards = list.filter((it) => (optOf(sf, val(it, sf)) ? val(it, sf) : '') === c.value).sort(sorter(s));
      return `<section class="col" data-drop-stage="${esc(c.value)}" data-drop-section="${esc(s.id)}">
        <div class="col-h"><i class="dot f-${c.color}"></i><b>${esc(c.label)}</b><span class="n">${cards.length}</span>${total && cards.length ? `<span class="sum">${moneyShortOrNum(total, sum(cards, (it) => val(it, total)))}</span>` : ''}</div>
        <div class="col-b">${cards.map((it) => card(s, it)).join('') || '<div class="none">Drop a card here</div>'}</div>
      </section>`;
    }).join('')}</div>`;
  }

  function card(s, it) {
    const fields = s.fields.filter((f) => f.onCard && f.key !== 'title' && f.key !== s.stageField);
    const mono = fields.find((f) => f.type === 'text');
    const meta = [];
    const chips = [];
    let people = [];
    fields.forEach((f) => {
      if (f === mono) return;
      const v = val(it, f);
      if (blank(v) || v === false) return;
      if (['select', 'checkbox'].includes(f.type)) chips.push(show(s, it, f, 'card'));
      else if (f.type === 'person') people.push(v);
      else if (f.due) return;
      else meta.push(f.type === 'date' || f.type === 'datetime' ? esc(f.label) + ' ' + show(s, it, f, 'card') : show(s, it, f, 'card'));
    });
    people = people.concat(it.editors || []);
    const nComments = S.comments.filter((c) => c.itemId === it.id && c.kind !== 'log').length;
    const drag = can.editItem(ctx(), it, s);
    return `<article class="card" tabindex="0" ${drag ? `draggable="true" data-drag="${esc(it.id)}"` : ''} data-act="open" data-id="${esc(it.id)}">
      ${mono && val(it, mono) ? `<div class="no">${esc(val(it, mono))}</div>` : ''}
      <div class="tt">${esc(it.title)}</div>
      ${meta.length ? `<div class="cl">${meta.join(' · ')}</div>` : ''}
      <div class="ft">${chip(dueInfo(s, it))}${chip(ageInfo(s, it))}${chips.join('')}
        ${(it.files || []).length ? `<span class="meta" title="Attachments">📎${it.files.length}</span>` : ''}
        ${nComments ? `<span class="meta" title="Comments">💬${nComments}</span>` : ''}
        <span class="sp"></span>${avatars(people, 3)}</div>
    </article>`;
  }

  function table(s, list) {
    if (!list.length) return '<div class="empty-state"><b>Nothing matches</b>Clear the search or the filters, or switch to All items.</div>';
    const cols = s.fields.filter((f) => f.type !== 'longtext');
    const st = fstate(s.id).sort;
    const arrow = (f) => (st.key === f.key ? (st.dir === 'desc' ? ' ↓' : ' ↑') : '');
    const rows = list.slice().sort(sorter(s)).map((it) => `
      <tr data-act="open" data-id="${esc(it.id)}">${cols.map((f) => `<td class="${f.key === 'title' ? 'title' : ['currency', 'number'].includes(f.type) ? 'r' : 'nw'}">${f.key === 'title' ? esc(it.title) + (ageInfo(s, it) ? ' ' + chip(ageInfo(s, it)) : '') : show(s, it, f, 'table')}</td>`).join('')}
        <td class="nw">${avatars(it.editors || [], 3)}</td></tr>`).join('');
    const totals = cols.some((f) => f.total);
    return `<div class="tablewrap"><table class="t"><thead><tr>${cols.map((f) => `<th class="${['currency', 'number'].includes(f.type) ? 'r' : ''}"><button type="button" class="thsort${st.key === f.key ? ' on' : ''}" data-act="sort-col" data-section="${esc(s.id)}" data-key="${esc(f.key)}">${esc(f.label)}${arrow(f)}</button></th>`).join('')}<th>Editors</th></tr></thead>
      <tbody>${rows}</tbody>${totals ? `<tfoot><tr>${cols.map((f, i) => `<td class="${f.total ? 'r' : ''}">${f.total ? moneyShortOrNum(f, sum(list, (it) => val(it, f))) : i === 0 ? 'Total' : ''}</td>`).join('')}<td></td></tr></tfoot>` : ''}</table></div>`;
  }

  // ------------------------------------------------------------ my work

  function viewMyWork() {
    const mine = S.items.filter((it) => { const s = sectionOf(it); return s && !s.archived && involved(it); });
    const open = mine.filter((it) => !isDone(sectionOf(it), it));
    const dueN = (it) => { const s = sectionOf(it); const f = !dueMet(s, it) && dueF(s); const v = f && val(it, f); return v ? daysFromToday(v.slice(0, 10)) : null; };
    const groups = [
      { k: 'Late', cls: 'crit', f: (it) => dueN(it) !== null && dueN(it) < 0 },
      { k: 'Today', f: (it) => dueN(it) === 0 },
      { k: 'Next 7 days', f: (it) => dueN(it) > 0 && dueN(it) <= 7 },
      { k: 'Later', f: (it) => dueN(it) > 7 },
      { k: 'No due date', f: (it) => dueN(it) === null },
    ];
    const li = (it) => {
      const s = sectionOf(it);
      return `<div class="li" data-act="open" data-id="${esc(it.id)}">${secMark(s)}
        <div class="tx"><b>${esc(it.title)}</b><small>${esc(s.name)} · ${esc(roleOn(it))}${stageOpt(s, it) ? ' · ' + esc(stageOpt(s, it).label) : ''}</small></div>
        <div class="rt">${chip(ageInfo(s, it))}${chip(dueInfo(s, it))}</div></div>`;
    };
    return `
      <div class="head"><div><h1>My Work</h1><div class="sub">Items where you are an editor, a collaborator or the named person · ${open.length} open</div></div></div>
      ${open.length ? groups.map((g) => { const its = open.filter(g.f).sort(byDue); return its.length ? `<div class="group"><h2 class="${g.cls || ''}">${g.k} · ${its.length}</h2><div class="list">${its.map(li).join('')}</div></div>` : ''; }).join('')
        : '<div class="empty-state"><b>Nothing open</b>Items you are assigned to in any section show up here.</div>'}`;
  }

  // ------------------------------------------------------------ super admin: sections

  // ------------------------------------------------------------ RFQ sourcing

  const SUPPLIER_TYPES = ['Manufacturer', 'Distributor', 'Stockist', 'Agent', 'Supplier'];
  const srcState = { sectionId: '', stage: '', drafts: {}, hub: null, loading: false, armed: '' };
  const srcRec = (id) => (S.sourcing || []).find((r) => r.id === id);
  const srcAccess = () => Core.sourcingAccess(ctx(), S.sections);

  // ---- reading RFQ Hub (read only)

  const hubStage = (s) => (s.fields || []).find((f) => f.key === s.stageField);
  const hubHasPending = (s) => { const f = hubStage(s); return !!f && (f.options || []).some((o) => /^pending\s*(\(|$)/i.test(o.label)); };
  const hubSections = () => ((srcState.hub && srcState.hub.sections) || []).filter((s) => !s.archived && hubStage(s) && (/^rfqs?$/.test(s.template || '') || hubHasPending(s)));

  function hubPickStage(s) {
    const opts = hubStage(s).options || [];
    if (opts.some((o) => o.value === srcState.stage)) return srcState.stage;
    const pick = opts.find((o) => /^pending$/i.test(o.label)) || opts.find((o) => /sourcing/i.test(o.label)) || opts[0];
    return pick ? pick.value : '';
  }

  /** The copy of an RFQ Hub task that this platform keeps. */
  function hubTask(s, it) {
    const data = it.data || {};
    const due = (s.fields || []).find((f) => f.due);
    return {
      id: it.id, hubSectionId: s.id, hubSectionName: s.name, title: it.title, rfqNo: data.rfqNo || '', client: data.client || '',
      closing: (due && data[due.key]) || '', items: data.notes || '',
      files: (it.files || []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size })), hubUpdatedAt: it.updatedAt || '',
    };
  }

  async function hubLoad() {
    srcState.loading = true;
    try {
      const res = await API.hubCall('bootstrap');
      srcState.hub = { sections: res.sections || [], items: res.items || [] };
    } catch (e) {
      srcState.hub = { error: e.message, sections: [], items: [] };
    }
    srcState.loading = false;
    if (route().view === 'sourcing') render();
  }

  // ---- screens

  function srcDraft(id) {
    const r = srcRec(id) || {};
    const held = srcState.drafts[id];
    // Unedited drafts follow what is saved, so changes made elsewhere show after a refresh.
    if (!held || (!held.edited && held.at !== r.updatedAt)) {
      srcState.drafts[id] = { at: r.updatedAt, edited: false, suppliers: (r.suppliers || []).map((x) => ({ ...x })), emailSubject: r.emailSubject || '', deliveryLocation: r.deliveryLocation || '' };
    }
    return srcState.drafts[id];
  }

  function srcStatusChip(r) {
    if (r && r.status === 'approved') return '<span class="chip ok">List approved</span>';
    if (r && (r.suppliers || []).length) return '<span class="chip warn">Waiting for approval</span>';
    return '<span class="chip">No suppliers yet</span>';
  }

  function hubPicker(a) {
    if (!srcState.hub) {
      if (!srcState.loading) setTimeout(hubLoad);
      return '<div class="empty-state"><b>Reading RFQ Hub…</b></div>';
    }
    if (srcState.hub.error) return `<div class="empty-state"><b>Could not read RFQ Hub</b>${esc(srcState.hub.error)}<div style="margin-top:10px"><button class="btn" data-act="src-hub-load">Try again</button></div></div>`;
    const secs = hubSections();
    if (!secs.length) return '<div class="empty-state"><b>No RFQ sections you can open in RFQ Hub</b></div>';
    // Newest section with a real Pending column first; the migrated monthly RFQ sections come last in the list.
    const s = secs.find((x) => x.id === srcState.sectionId) || secs.filter(hubHasPending).pop() || secs[0];
    const stage = hubPickStage(s);
    const list = srcState.hub.items.filter((it) => it.sectionId === s.id && (it.data || {})[s.stageField] === stage).map((it) => hubTask(s, it))
      .sort((x, y) => (x.closing || '9999').localeCompare(y.closing || '9999'));
    const rows = list.map((t) => `<tr>
        <td class="title">${esc(t.title)}</td><td class="nw">${esc(t.rfqNo || '—')}</td><td class="nw">${esc(fmtDT(t.closing))}</td><td class="r">${t.files.length}</td>
        <td class="nw r">${srcRec(t.id) ? `<a class="btn sm" href="#sourcing/${esc(t.id)}">Open</a>` : (a.edit ? `<button class="btn sm primary" data-act="src-import" data-id="${esc(t.id)}" data-section="${esc(s.id)}">Import</button>` : '')}</td></tr>`).join('');
    return `
      <div class="toolbar src-pick">
        <label class="fld"><span>RFQ Hub section</span><select id="srcSection">${secs.map((x) => `<option value="${esc(x.id)}"${x.id === s.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
        <label class="fld"><span>Column</span><select id="srcStage">${(hubStage(s).options || []).map((o) => `<option value="${esc(o.value)}"${o.value === stage ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>
        <button class="btn" data-act="src-hub-load">Reload from RFQ Hub</button>
      </div>
      ${list.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Task</th><th>RFQ no.</th><th>Closing</th><th class="r">Attachments</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="empty-state"><b>No tasks in this column</b></div>'}`;
  }

  function viewSourcing() {
    const a = srcAccess();
    if (!a.view) return '<div class="empty-state"><b>You do not have access to RFQ Sourcing</b>Ask the super admin for access to the Supplier Register.</div>';
    const mine = (S.sourcing || []).slice().sort((x, y) => (x.closing || '9999').localeCompare(y.closing || '9999'));
    return `
      <div class="head"><div><h1>RFQ Sourcing</h1><div class="sub">Import a task from RFQ Hub, then review and approve its supplier list. RFQ Hub is only read, never changed.</div></div></div>
      <div class="group"><h2>Imported tasks (${mine.length})</h2>
        ${mine.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Task</th><th>RFQ no.</th><th>Closing</th><th class="r">Suppliers</th><th>Status</th></tr></thead><tbody>${mine.map((r) => `<tr>
          <td class="title"><a href="#sourcing/${esc(r.id)}">${esc(r.title)}</a></td><td class="nw">${esc(r.rfqNo || '—')}</td><td class="nw">${esc(fmtDT(r.closing))}</td>
          <td class="r">${(r.suppliers || []).length}</td><td class="nw">${srcStatusChip(r)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing imported yet.</p>'}
      </div>
      <div class="group"><h2>From RFQ Hub</h2>${hubPicker(a)}</div>`;
  }

  function supplierRow(x, i, locked) {
    const dis = locked ? ' disabled' : '';
    const type = x.type && !SUPPLIER_TYPES.includes(x.type) ? [x.type, ...SUPPLIER_TYPES] : SUPPLIER_TYPES;
    return `<tr data-sup="${i}">
      <td><input name="company" aria-label="Company" value="${esc(x.company || '')}"${dis}></td>
      <td><input name="email" type="email" aria-label="Email" value="${esc(x.email || '')}"${dis}></td>
      <td><select name="type" aria-label="Type"${dis}><option value=""></option>${type.map((t) => `<option${t === x.type ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></td>
      <td><input name="country" aria-label="Country" value="${esc(x.country || '')}"${dis}></td>
      <td><input name="source" type="url" aria-label="Source link" value="${esc(x.source || '')}"${dis}>${/^https?:\/\//i.test(x.source || '') ? ` <a href="${esc(x.source)}" target="_blank" rel="noopener">Open</a>` : ''}</td>
      <td><input name="note" aria-label="Note" value="${esc(x.note || '')}"${dis}></td>
      <td>${locked ? '' : `<button type="button" class="ibtn" data-act="src-del" data-i="${i}" aria-label="Remove supplier">×</button>`}</td></tr>`;
  }

  /** Suppliers in the register that can still be used: blacklisted and inactive ones (done stages) are left out. */
  function registerSuppliers() {
    const out = [];
    liveSections().filter((s) => s.template === 'suppliers').forEach((s) => {
      const sf = stageF(s);
      S.items.filter((it) => it.sectionId === s.id).forEach((it) => {
        const opt = sf && (sf.options || []).find((o) => o.value === val(it, sf));
        if (opt && opt.done) return;
        const d = it.data || {};
        const found = /[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+/.exec(String(d.email || d.phone || ''));
        out.push({ id: it.id, company: it.title, email: found ? found[0] : '', country: d.country || '', type: d.supplierType || '', source: d.website || '' });
      });
    });
    return out.sort((a, b) => a.company.localeCompare(b.company));
  }

  function viewSourcingTask(id) {
    const r = srcRec(id);
    if (!r) return '<div class="empty-state"><b>This task has not been imported</b><a href="#sourcing">Back to RFQ Sourcing</a></div>';
    const a = srcAccess();
    const d = srcDraft(id);
    const past = r.closing && hoursUntil(r.closing) < 0;
    const items = Core.rfqItemsText(r.items);
    const mailFiles = (r.mailFiles || []).map((f) => f.name);
    const reg = a.edit ? registerSuppliers() : [];
    return `
      <div class="head"><div><a href="#sourcing">‹ RFQ Sourcing</a><h1>${esc(r.title)}</h1>
        <div class="sub">${esc(r.hubSectionName || 'RFQ Hub')} · ${esc(r.rfqNo || 'No RFQ no.')} · Closing ${esc(fmtDT(r.closing))} ${past ? '<span class="chip crit">Closing date has passed</span>' : ''}</div></div>
        <div class="toolbar">${srcStatusChip(r)}${a.edit ? `<button class="btn" data-act="src-refresh" data-id="${esc(id)}">Refresh from RFQ Hub</button>` : ''}</div></div>
      <div class="group"><h2>Items to quote</h2><pre class="src-pre">${items ? esc(items) : '<span class="muted">The Notes of this task are empty.</span>'}</pre></div>
      <div class="group"><h2>Attachments</h2>${(r.files || []).length ? `<ul class="src-files">${r.files.map((f) => `<li>${esc(f.name)}</li>`).join('')}</ul>` : '<p class="muted">None on this task.</p>'}${mailFiles.length ? `<p class="muted">Copied for the emails: ${esc(mailFiles.join(', '))}</p>` : ''}</div>
      <form id="srcForm" data-id="${esc(id)}" novalidate>
        <div class="group"><h2>Email details</h2><div class="src-fields">
          <label class="fld"><span>Email title</span><input name="emailSubject" value="${esc(d.emailSubject)}"${a.edit ? '' : ' disabled'}></label>
          <label class="fld"><span>Delivery location</span><input name="deliveryLocation" value="${esc(d.deliveryLocation)}"${a.edit ? '' : ' disabled'}></label>
        </div></div>
        <div class="group"><h2>Suppliers (${d.suppliers.length})</h2>
          <div class="tablewrap"><table class="t src-sup"><thead><tr><th>Company</th><th>Email</th><th>Type</th><th>Country</th><th>Source link</th><th>Note</th><th></th></tr></thead>
            <tbody>${d.suppliers.map((x, i) => supplierRow(x, i, !a.edit)).join('') || '<tr><td colspan="7" class="muted">No suppliers yet.</td></tr>'}</tbody></table></div>
          ${a.edit ? `<div class="form-actions src-actions"><button type="button" class="btn" data-act="src-add">+ Add supplier</button>
            ${reg.length ? `<select id="srcRegister" aria-label="Add from Supplier Register"><option value="">+ Add from Supplier Register</option>${reg.map((x) => `<option value="${esc(x.id)}">${esc(x.company)}${x.email ? '' : ' (no email)'}</option>`).join('')}</select>` : ''}
            <span class="sp"></span>
            <button type="button" class="btn${srcState.armed === id ? ' danger armed' : ' danger'}" data-act="src-remove" data-id="${esc(id)}">${srcState.armed === id ? 'Click again to remove' : 'Remove task'}</button>
            <button type="button" class="btn" data-act="src-save">Save draft</button>
            ${a.approve ? '<button type="button" class="btn primary" data-act="src-approve">Approve final list</button>' : '<span class="muted">A manager approves this list.</span>'}</div>` : ''}
          ${r.status === 'approved' ? `<p class="muted">Approved by ${esc(userName(r.approvedBy))} on ${esc(fmtDT(r.approvedAt))}. Saving a change returns the list to draft.</p>` : ''}
        </div>
      </form>
      <details class="group"><summary>Email preview</summary><p class="muted"><b>${esc(d.emailSubject || '[email title]')}</b></p><pre class="src-pre">${esc(Core.rfqEmailBody(Object.assign({}, r, { deliveryLocation: d.deliveryLocation }), S.settings))}</pre></details>
      ${emailPanel(r, a, d)}
      ${comparisonPanel(r, a)}`;
  }

  // ---- actions

  /** Copy what is on screen into the draft, so a background refresh or added row keeps it. */
  function srcSync() {
    const form = $('#srcForm');
    if (!form) return null;
    const d = srcDraft(form.dataset.id);
    d.edited = true;
    d.emailSubject = form.elements.emailSubject.value;
    d.deliveryLocation = form.elements.deliveryLocation.value;
    d.suppliers = [...form.querySelectorAll('tr[data-sup]')].map((tr) => {
      const v = (n) => tr.querySelector(`[name="${n}"]`).value;
      return { company: v('company'), email: v('email'), type: v('type'), country: v('country'), source: v('source'), note: v('note') };
    });
    return d;
  }

  function srcKeep(rec) {
    S.sourcing = (S.sourcing || []).filter((r) => r.id !== rec.id).concat([rec]);
  }

  async function srcSubmit(action) {
    const id = $('#srcForm').dataset.id;
    const d = srcSync();
    try {
      const res = await API.call(action, { itemId: id, suppliers: d.suppliers, emailSubject: d.emailSubject, deliveryLocation: d.deliveryLocation });
      srcKeep(res.sourcing);
      delete srcState.drafts[id];
      toast(action === 'sourcing.approve' ? 'Supplier list approved' : 'Draft saved');
      render();
    } catch (e) { handleError(e); }
  }

  async function srcImport(itemId, sectionId) {
    const s = hubSections().find((x) => x.id === sectionId);
    const it = srcState.hub.items.find((x) => x.id === itemId);
    if (!s || !it) { toast('This task is no longer in RFQ Hub', true); return; }
    try {
      const res = await API.call('sourcing.import', { task: hubTask(s, it) });
      srcKeep(res.sourcing);
      location.hash = '#sourcing/' + itemId;
    } catch (e) { handleError(e); }
  }

  /** Read this task again from RFQ Hub, so a changed closing date or item list is picked up. */
  async function srcRefresh(id) {
    await hubLoad();
    if (srcState.hub.error) { toast(srcState.hub.error, true); return; }
    const it = srcState.hub.items.find((x) => x.id === id);
    const s = it && srcState.hub.sections.find((x) => x.id === it.sectionId);
    if (!s) { toast('This task is no longer in RFQ Hub', true); return; }
    try {
      const res = await API.call('sourcing.import', { task: hubTask(s, it) });
      srcKeep(res.sourcing);
      toast('Updated from RFQ Hub');
      render();
    } catch (e) { handleError(e); }
  }

  async function srcRemove(id) {
    if (srcState.armed !== id) { srcSync(); srcState.armed = id; render(); return; }
    srcState.armed = '';
    try {
      await API.call('sourcing.remove', { itemId: id });
      S.sourcing = (S.sourcing || []).filter((r) => r.id !== id);
      delete srcState.drafts[id];
      toast('Task removed from RFQ Sourcing');
      location.hash = '#sourcing';
    } catch (e) { handleError(e); }
  }

  // ---- RFQ emails

  const srcMails = (id) => (S.emails || []).filter((e) => e.taskId === id);
  const mailStale = (r, e) => r.status !== 'approved' || e.listApprovedAt !== r.approvedAt || e.subject !== r.emailSubject
    || e.cc !== (S.settings || {}).cc || e.body !== Core.rfqEmailBody(r, S.settings);
  const gmailUrl = (hash) => `https://mail.google.com/mail/u/?authuser=${encodeURIComponent((S.settings || {}).fromEmail || '')}#${hash}`;

  function replyChip(e) {
    if (e.status !== 'sent') return '';
    const n = Number(e.followUps) || 0;
    const chased = n ? ` · ${n} follow-up${n > 1 ? 's' : ''}` : '';
    if (e.replyStatus === 'quote') return `<span class="chip ok">Possible quotation</span>${chased}`;
    if (e.replyStatus === 'query') return `<span class="chip warn">Reply: decide</span>${chased}`;
    if (e.replyStatus === 'bounced') return '<span class="chip crit">Bounced</span>';
    return `<span class="muted">${e.replyStatus === 'auto' ? 'Auto-reply only' : 'No reply yet'}${chased}</span>`;
  }

  async function srcCheckReplies() {
    try {
      setBusy('Checking replies in Gmail…');
      const res = await API.call('monitor.run');
      S.emails = res.emails;
      const r = res.result;
      toast(`${r.checked} threads checked, ${r.replies} new replies${r.errors.length ? ', ' + r.errors.length + ' errors' : ''}`, !!r.errors.length);
    } catch (e) { handleError(e); }
    setBusy('');
  }

  function mailChip(e, stale) {
    if (e.status === 'sent') return `<span class="chip ok">Sent ${esc(fmtDT(e.sentAt))}</span>`;
    if (e.status === 'failed') return `<span class="chip crit" title="${esc(e.error)}">Failed</span>`;
    if (e.status === 'sending') return '<span class="chip crit">Check Gmail</span>';
    return stale ? '<span class="chip warn">Out of date</span>' : '<span class="chip info">Draft</span>';
  }

  function mailQuotaLine(unsent) {
    const st = srcState.mailStatus;
    const per = 1 + String((S.settings || {}).cc || '').split('; ').filter(Boolean).length;
    if (!st) { if (!srcState.mailLoading) setTimeout(srcMailLoad); return ''; }
    if (st.error) return `<p class="muted">Could not read the Gmail limit: ${esc(st.error)}</p>`;
    const need = unsent * per;
    const short = need > st.remaining;
    return `<p class="${short ? 'src-warn' : 'muted'}">Sending from ${esc(st.account)}. Google allows ${esc(String(st.remaining))} more recipients today; ${unsent} emails to send use up to ${need} (${per} each, counting CC).${short ? ' Not all of them can go today.' : ''}</p>`;
  }

  function emailPanel(r, a, d) {
    const set = S.settings;
    if (!set || !set.signature) return `<div class="group"><h2>RFQ emails</h2><div class="banner"><b>Email settings needed</b><span>${S.me.isSuper ? '<a href="#mailsettings">Fill in the sender, CC list and signature</a> first.' : 'A super admin must fill in the sender, CC list and signature first.'}</span></div></div>`;
    const mails = srcMails(r.id);
    const unsentList = mails.filter((e) => e.status === 'draft' || e.status === 'failed');
    const freshUnsent = unsentList.filter((e) => !mailStale(r, e));
    const anyStale = unsentList.some((e) => mailStale(r, e));
    const asana = Core.asanaOnlyFiles(r.items).filter((n) => !(r.mailFiles || []).some((f) => f.name === n));
    const dr = srcDraft(r.id);
    const unsaved = dr.edited || (dr.emailSubject || '') !== (r.emailSubject || '') || (dr.deliveryLocation || '') !== (r.deliveryLocation || '');
    const missing = [];
    if (r.status !== 'approved') missing.push('approve the supplier list');
    if (unsaved) missing.push('save your changes');
    if (!r.emailSubject) missing.push('enter the email title');
    if (!r.deliveryLocation) missing.push('enter the delivery location');
    const busy = srcState.mailBusy;
    const canDraft = a.approve && !missing.length && !busy && (!asana.length || srcState.skipAsana === r.id);
    const rows = mails.map((e) => `<tr><td class="title">${esc(e.company || '—')}</td><td class="nw">${esc(e.email)}</td><td class="nw">${mailChip(e, mailStale(r, e))}</td><td class="nw" title="${esc(e.replySnippet || '')}">${replyChip(e)}</td>
      <td class="nw">${e.status === 'sent' ? `<a href="${esc(gmailUrl('all/' + e.threadId))}" target="_blank" rel="noopener">Open email</a>` : `<a href="${esc(gmailUrl('drafts?compose=' + e.messageId))}" target="_blank" rel="noopener">Open draft</a>`}</td></tr>`).join('');
    return `<div class="group"><h2>RFQ emails</h2>
      <p class="muted">From ${esc(set.fromEmail)} · CC ${esc(set.cc || 'none')}</p>
      ${asana.length ? `<div class="banner"><b>Only in Asana</b><span>Upload to the RFQ Hub task, then create the drafts: ${esc(asana.join(', '))}</span></div>
        <label class="fld chk src-skip"><input type="checkbox" id="srcSkipAsana" ${srcState.skipAsana === r.id ? 'checked' : ''}><span>Create the drafts without these files</span></label>` : ''}
      ${missing.length ? `<p class="muted">Before making drafts: ${esc(missing.join(', '))}.</p>` : ''}
      ${busy ? `<p class="src-warn">${esc(busy)}</p>` : ''}
      ${mails.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Company</th><th>To</th><th>Status</th><th>Reply</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
      ${anyStale ? '<p class="src-warn">The task, list or settings changed. Create the drafts again before sending.</p>' : ''}
      ${mails.some((e) => e.status === 'failed') ? `<p class="src-warn">${esc(mails.find((e) => e.status === 'failed').error)}</p>` : ''}
      ${a.approve ? `<div class="form-actions src-actions">
        ${mails.some((e) => e.status === 'sent') ? `<button type="button" class="btn" data-act="src-check" ${busy ? 'disabled' : ''}>Check replies now</button>` : ''}
        <button type="button" class="btn" data-act="src-test" data-id="${esc(r.id)}" ${busy || unsaved || !r.emailSubject || !r.deliveryLocation ? 'disabled' : ''}>Send test to me</button>
        <button type="button" class="btn" data-act="src-prepare" data-id="${esc(r.id)}" ${canDraft ? '' : 'disabled'}>${unsentList.length ? 'Create drafts again' : 'Create drafts'}</button>
        <span class="sp"></span>
        ${freshUnsent.length && !anyStale ? `<button type="button" class="btn ${srcState.armedSend === r.id ? 'danger armed' : 'primary'}" data-act="src-send" data-id="${esc(r.id)}" ${busy || unsaved ? 'disabled' : ''}>${srcState.armedSend === r.id ? `Click again to send ${freshUnsent.length} now` : `Approve and send ${freshUnsent.length} emails`}</button>` : ''}
      </div>${freshUnsent.length ? mailQuotaLine(freshUnsent.length) : ''}` : ''}
    </div>`;
  }

  async function srcMailLoad() {
    srcState.mailLoading = true;
    try { srcState.mailStatus = await API.call('mail.status'); } catch (e) { srcState.mailStatus = { error: e.message }; }
    srcState.mailLoading = false;
    if (route().view === 'sourcing' || route().view === 'mailsettings') render();
  }

  function setBusy(text) { srcState.mailBusy = text; render(); }

  /** Read the task again from RFQ Hub and copy its files here, so the drafts use the latest closing date and items. */
  async function srcPull(id) {
    await hubLoad();
    if (srcState.hub.error) throw new Error(srcState.hub.error);
    const it = srcState.hub.items.find((x) => x.id === id);
    const s = it && srcState.hub.sections.find((x) => x.id === it.sectionId);
    if (!s) throw new Error('This task is no longer in RFQ Hub.');
    const res = await API.call('sourcing.import', { task: hubTask(s, it) });
    srcKeep(res.sourcing);
    delete srcState.drafts[id];
    return res.sourcing;
  }

  async function srcPrepare(id) {
    try {
      setBusy('Reading the latest task from RFQ Hub…');
      let r = await srcPull(id);
      for (const f of r.files || []) {
        if ((r.mailFiles || []).some((m) => m.hubFileId === f.id)) continue;
        setBusy('Copying attachment: ' + f.name);
        const file = await API.hubCall('item.file', { id, fileId: f.id });
        r = (await API.call('sourcing.attach', { itemId: id, hubFileId: f.id, fileName: f.name, mimeType: f.mimeType, base64: file.base64 })).sourcing;
        srcKeep(r);
      }
      await API.call('sourcing.clearDrafts', { itemId: id });
      let i = 0;
      for (const sup of r.suppliers || []) {
        i += 1;
        setBusy(`Creating draft ${i} of ${r.suppliers.length}: ${sup.email}`);
        await API.call('sourcing.prepare', { itemId: id, email: sup.email, skipAsana: srcState.skipAsana === id });
      }
      await loadData(true);
      toast(`${i} drafts ready in Gmail. Nothing has been sent.`);
    } catch (e) { handleError(e); await loadData(true); }
    setBusy('');
  }

  async function srcSend(id) {
    if (srcState.armedSend !== id) { srcState.armedSend = id; render(); return; }
    srcState.armedSend = '';
    const list = srcMails(id).filter((e) => e.status === 'draft' || e.status === 'failed');
    let sent = 0;
    try {
      for (const e of list) {
        setBusy(`Sending ${sent + 1} of ${list.length}: ${e.email}`);
        const res = await API.call('sourcing.send', { emailId: e.id });
        if (res.email.status !== 'sent') throw new Error(`Stopped at ${e.email}: ${res.email.error}`);
        sent += 1;
      }
      toast(`${sent} RFQ emails sent`);
    } catch (e) {
      toast(`${sent} of ${list.length} sent. ${e.message}`, true);
    }
    srcState.mailStatus = null;
    await loadData(true);
    setBusy('');
  }

  async function srcTest(id) {
    try {
      setBusy('Sending a test email to you…');
      const res = await API.call('sourcing.test', { itemId: id });
      srcState.mailStatus = res.status;
      toast('Test email sent to ' + res.to + ' only');
    } catch (e) { handleError(e); }
    setBusy('');
  }

  // ---- quotation comparison

  const rmText = (v) => (v === null || v === undefined || v === '' ? '—' : nf2.format(Number(v)));

  function quoteEditor(row, a) {
    const q = (S.quotes || []).find((x) => x.id === row.emailId) || { data: {} };
    const d = q.data || {};
    const fld = (name, label, type) => `<label class="fld"><span>${label}</span><input name="${name}" ${type === 'number' ? 'type="number" step="any"' : ''} value="${esc(d[name] === null || d[name] === undefined ? '' : d[name])}" ${a.edit ? '' : 'disabled'}></label>`;
    const line = (it, i) => `<tr data-line="${i}">${[['rfqItemNo', 'number'], ['description'], ['offeredMake'], ['qty', 'number'], ['uom'], ['unitPrice', 'number'], ['lineTotal', 'number']].map(([n, t]) => `<td><input name="${n}" aria-label="${n}" ${t ? 'type="number" step="any"' : ''} value="${esc(it[n] === null || it[n] === undefined ? '' : it[n])}" ${a.edit ? '' : 'disabled'}></td>`).join('')}</tr>`;
    const lines = (d.items || []).concat(a.edit ? [{}] : []);
    return `<details class="src-quote" data-email="${esc(row.emailId)}"><summary>${esc(row.company || row.email)}${q.source ? ` · ${esc(q.source)}` : ''}</summary>
      <div class="src-fields">${fld('quoteRef', 'Quote ref')}${fld('currency', 'Currency (USD, MYR…)')}${fld('validUntil', 'Valid until')}${fld('leadTime', 'Lead time')}${fld('originCountry', 'Ships from')}${fld('netWeightKg', 'Net kg', 'number')}${fld('grossWeightKg', 'Gross kg', 'number')}${fld('packages', 'Packages', 'number')}${fld('lengthCm', 'Length cm', 'number')}${fld('widthCm', 'Width cm', 'number')}${fld('heightCm', 'Height cm', 'number')}${fld('freightCost', 'Supplier freight', 'number')}${fld('freightCurrency', 'Freight currency')}${fld('incoterm', 'Incoterm')}
        <label class="fld"><span>Imported (10% SST)</span><select name="imported" ${a.edit ? '' : 'disabled'}><option value="">Decide from origin</option><option value="yes"${d.imported === true ? ' selected' : ''}>Yes</option><option value="no"${d.imported === false ? ' selected' : ''}>No</option></select></label></div>
      <label class="fld src-note"><span>Notes</span><textarea name="notes" rows="2" ${a.edit ? '' : 'disabled'}>${esc(d.notes || '')}</textarea></label>
      <div class="tablewrap"><table class="t src-sup"><thead><tr><th>RFQ item</th><th>Description</th><th>Offered make</th><th>Qty</th><th>UOM</th><th>Unit price</th><th>Line total</th></tr></thead><tbody>${lines.map(line).join('')}</tbody></table></div>
      ${a.edit ? `<div class="form-actions src-actions"><button type="button" class="btn" data-act="quote-download" data-id="${esc(row.emailId)}">Download emails and files</button><span class="sp"></span><button type="button" class="btn" data-act="quote-save" data-id="${esc(row.emailId)}">Save</button><button type="button" class="btn primary" data-act="quote-confirm" data-id="${esc(row.emailId)}">Save and mark checked</button></div>` : ''}
    </details>`;
  }

  function comparisonPanel(r, a) {
    if (!srcMails(r.id).some((e) => e.status === 'sent')) return '';
    const rows = Core.comparison(r, S.emails || [], S.quotes || [], S.settings || {});
    const byItem = Core.comparisonByItem(rows);
    const stateOf = (x) => {
      if (x.confirmed) return '<span class="chip ok">Checked</span>';
      if (x.quoteStatus === 'pending') return '<span class="chip info">Quotation received: enter it</span>';
      if (x.lines.length) return '<span class="chip warn">Entered: check</span>';
      return `<span class="muted">${x.replyStatus === 'bounced' ? 'Bounced' : x.replyStatus === 'query' ? 'Reply: decide' : 'No quotation'}</span>`;
    };
    const rates = (S.settings || {}).rates || {};
    const used = [...new Set(rows.map((x) => x.currency).filter((c) => c && c !== 'MYR'))].filter((c) => rates[c]);
    return `<div class="group"><h2>Quotation comparison (RM)</h2>
      <div class="tablewrap"><table class="t src-cmp"><thead><tr><th>Supplier</th><th>State</th><th class="r">Items</th><th class="r">Freight</th><th>Freight basis</th><th class="r">Gross kg</th><th class="r">Vol kg</th><th>Dimensions</th><th class="r">SST 10%</th><th class="r">Total</th><th>Lead time</th><th>Valid until</th><th>Email</th></tr></thead>
        <tbody>${rows.map((x) => `<tr><td class="title">${esc(x.company || x.email)}${(x.warnings || []).map((w) => `<div class="src-warn">${esc(w)}</div>`).join('')}${x.notes ? `<div class="muted">${esc(x.notes)}</div>` : ''}</td><td class="nw">${stateOf(x)}</td>
          <td class="r">${rmText(x.itemRm)}</td><td class="r">${rmText(x.freightRm)}</td><td>${esc(x.freightSource || '—')}</td><td class="r">${rmText(x.grossKg)}</td><td class="r">${rmText(x.volumetricKg)}</td><td class="nw">${esc(x.dimensions || '—')}</td><td class="r">${rmText(x.sstRm)}</td><td class="r"><b>${rmText(x.landedRm)}</b>${x.lines.length && !x.complete ? '<div class="src-warn">Incomplete</div>' : ''}</td><td>${esc(x.leadTime || '—')}</td><td>${esc(x.validUntil || '—')}</td>
          <td class="nw"><a href="${esc(gmailUrl('all/' + x.threadId))}" target="_blank" rel="noopener">Open</a></td></tr>`).join('')}</tbody></table></div>
      ${byItem.length ? `<h2 class="src-sub">By RFQ item</h2><div class="tablewrap"><table class="t src-cmp"><thead><tr><th>RFQ item</th><th>Supplier</th><th>Offered</th><th class="r">Qty</th><th class="r">Unit RM</th><th class="r">Line RM</th><th>Lead time</th></tr></thead>
        <tbody>${byItem.map((g) => g.offers.map((o, i) => `<tr><td class="nw">${i === 0 ? esc(g.item) : ''}</td><td>${esc(o.company)}</td><td>${esc(o.offeredMake || o.description)}</td><td class="r">${esc(o.qty === null ? '—' : o.qty)} ${esc(o.uom)}</td><td class="r">${rmText(o.unitRm)}</td><td class="r">${rmText(o.lineRm)}</td><td>${esc(o.leadTime || '—')}</td></tr>`).join('')).join('')}</tbody></table></div>` : ''}
      <p class="muted">Check entered figures against the email. SST is 10% of items plus freight on imported goods. Exchange rates: Bank Negara selling rate${used.length ? ` (${used.map((c) => `${esc(c)} ${esc(Number(rates[c].rate).toFixed(4))} on ${esc(rates[c].date)}`).join(', ')})` : ''}.</p>
      <h2 class="src-sub">Quotation details</h2>${rows.map((x) => quoteEditor(x, a)).join('')}
    </div>`;
  }

  function quoteFromForm(id) {
    const box = document.querySelector(`.src-quote[data-email="${id}"]`);
    const data = {};
    const val2 = (n) => box.querySelector(`[name="${n}"]`).value.trim();
    ['quoteRef', 'currency', 'validUntil', 'leadTime', 'originCountry', 'freightCurrency', 'incoterm', 'notes'].forEach((n) => { data[n] = val2(n) || null; });
    ['netWeightKg', 'grossWeightKg', 'packages', 'lengthCm', 'widthCm', 'heightCm', 'freightCost'].forEach((n) => { data[n] = val2(n) === '' ? null : Number(val2(n)); });
    const imp = val2('imported');
    if (imp) data.imported = imp === 'yes';
    data.items = [...box.querySelectorAll('tr[data-line]')].map((tr) => {
      const v = (n) => tr.querySelector(`[name="${n}"]`).value.trim();
      const n = (k) => (v(k) === '' ? null : Number(v(k)));
      return { rfqItemNo: n('rfqItemNo'), description: v('description') || null, offeredMake: v('offeredMake') || null, qty: n('qty'), uom: v('uom') || null, unitPrice: n('unitPrice'), lineTotal: n('lineTotal') };
    }).filter((l) => l.description || l.unitPrice !== null || l.lineTotal !== null);
    return data;
  }

  async function quoteSave(id, confirmed) {
    try {
      const res = await API.call('quote.save', { emailId: id, data: quoteFromForm(id), confirmed });
      S.quotes = (S.quotes || []).filter((q) => q.id !== id).concat([res.quote]);
      toast(confirmed ? 'Saved and marked checked' : 'Saved');
      render();
    } catch (e) { handleError(e); }
  }

  function saveAs(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  /** Download one supplier's emails and files so they can be read and entered here. */
  async function quoteDownload(id) {
    const e = (S.emails || []).find((x) => x.id === id);
    const tag = String((e && e.company) || 'supplier').replace(/[^\w-]+/g, '_').slice(0, 40);
    try {
      setBusy('Fetching the quotation files…');
      const res = await API.call('quote.files', { emailId: id });
      saveAs(`${tag}_emails.txt`, new Blob([res.text || ''], { type: 'text/plain' }));
      (res.files || []).forEach((f) => {
        if (f.kind === 'text') { saveAs(`${tag}_${f.name}.txt`, new Blob([f.text || ''], { type: 'text/plain' })); return; }
        const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
        saveAs(`${tag}_${f.name}`, new Blob([bytes], { type: f.mime || 'application/pdf' }));
      });
      toast(`${(res.files || []).length + 1} files downloaded${(res.skipped || []).length ? '. Open in Gmail: ' + res.skipped.join(', ') : ''}`, !!(res.skipped || []).length);
    } catch (err) { handleError(err); }
    setBusy('');
  }

  // ---- email settings (kept in the private Sheet, not in the public code)

  function viewMailSettings() {
    if (!S.me.isSuper) return '<div class="empty-state"><b>Super admin only</b></div>';
    const set = S.settings || {};
    const st = srcState.mailStatus;
    if (!st && !srcState.mailLoading) setTimeout(srcMailLoad);
    return `<div class="head"><div><h1>Email settings</h1><div class="sub">Used for every RFQ email. Saved in the private Google Sheet.</div></div></div>
      <form id="mailSettings" class="src-settings" novalidate>
        <label class="fld"><span>Send from (must match the account the backend runs on)</span><input name="fromEmail" type="email" value="${esc(set.fromEmail || '')}"></label>
        <label class="fld"><span>CC on every RFQ email</span><textarea name="cc" rows="3">${esc(set.cc || '')}</textarea></label>
        <label class="fld"><span>Signature (printed under “Warmest Regards,”)</span><textarea name="signature" rows="9">${esc(set.signature || '')}</textarea></label>
        <label class="fld"><span>Send supplier reply alerts to</span><input name="notifyEmail" type="email" value="${esc(set.notifyEmail || '')}"></label>
        <label class="fld chk"><input type="checkbox" name="followUpOn" ${set.followUpOn ? 'checked' : ''}><span>Send follow-ups automatically: 9am daily, plus a final reminder at 1pm on the closing day, only to suppliers with no reply</span></label>
        <label class="fld"><span>Freight rates, one per line: origin country, delivery place, RM per chargeable kg</span><textarea name="freightRates" rows="5" placeholder="United Kingdom, Labuan, 45">${esc(set.freightRates || '')}</textarea></label>
        <label class="fld"><span>Volumetric divisor (cm³ per kg)</span><input name="volumetricDivisor" type="number" value="${esc(set.volumetricDivisor || 5000)}"></label>
        <details><summary>Follow-up wording</summary><pre class="src-pre">${esc(Core.followUpBody({ closing: '2026-11-05T23:00' }, { signature: set.signature || '[signature]' }, false))}</pre><pre class="src-pre">${esc(Core.followUpBody({ closing: '2026-11-05T23:00' }, { signature: set.signature || '[signature]' }, true))}</pre></details>
        <div class="form-actions"><button type="submit" class="btn primary">Save</button></div>
      </form>
      <p class="muted">${st ? (st.error ? esc(st.error) : `This platform sends as ${esc(st.account)}. Google allows ${esc(String(st.remaining))} more recipients today.`) : 'Checking the Gmail connection…'}</p>`;
  }

  async function saveMailSettings(form) {
    try {
      const res = await API.call('settings.save', { fromEmail: form.elements.fromEmail.value, cc: form.elements.cc.value, signature: form.elements.signature.value, notifyEmail: form.elements.notifyEmail.value, followUpOn: form.elements.followUpOn.checked, freightRates: form.elements.freightRates.value, volumetricDivisor: form.elements.volumetricDivisor.value });
      S.settings = res.settings;
      toast('Email settings saved');
      render();
    } catch (e) { handleError(e); }
  }

  function viewSections() {
    if (!S.me.isSuper) return '<div class="empty-state"><b>Super admin only</b></div>';
    const live = liveSections();
    const gone = S.sections.filter((s) => s.archived);
    const row = (s, i) => `<tr>
      <td class="nw">${s.archived ? '' : `<button class="ibtn" data-act="sec-move" data-id="${esc(s.id)}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button class="ibtn" data-act="sec-move" data-id="${esc(s.id)}" data-dir="1" ${i === live.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>`}</td>
      <td class="title">${secMark(s)} <a href="#s/${esc(s.id)}">${esc(s.name)}</a></td>
      <td class="r">${S.items.filter((it) => it.sectionId === s.id).length}</td><td class="r">${s.fields.length}</td>
      <td class="nw">${stageF(s) ? esc(stageF(s).label) : '<span class="muted">Table only</span>'}</td>
      <td class="r">${S.access.filter((a) => a.sectionId === s.id).length}</td>
      <td class="nw r">${s.archived ? `<button class="btn sm" data-act="arc-open" data-mode="backup" data-id="${esc(s.id)}">Back up</button> <button class="btn sm" data-act="sec-restore" data-id="${esc(s.id)}">Show again</button> <button class="btn sm danger" data-act="arc-open" data-mode="remove" data-id="${esc(s.id)}">Delete permanently</button>`
        : `<a class="btn sm" href="#s/${esc(s.id)}/customize">Customize</a> <button class="btn sm" data-act="arc-open" data-mode="backup" data-id="${esc(s.id)}">Back up</button> <button class="btn sm danger" data-act="arc-open" data-mode="remove" data-id="${esc(s.id)}">Remove</button>`}</td></tr>`;
    return `
      <div class="head"><div><h1>Manage sections</h1><div class="sub">Add, rename and reorder sections. <b>Back up</b> downloads a section as one archive file you can open in any browser. <b>Remove</b> downloads that file and then deletes the section and all its data from the Google Sheet. <b>Restore from archive</b> puts a file back into the platform and the Google Sheet.</div></div>
        <div class="toolbar"><button class="btn" data-act="arc-restore">Restore from archive</button><button class="btn primary" data-act="sec-new">+ New section</button></div></div>
      ${live.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Order</th><th>Section</th><th class="r">Items</th><th class="r">Columns</th><th>Board by</th><th class="r">Users</th><th></th></tr></thead><tbody>${live.map(row).join('')}</tbody></table></div>`
        : `<div class="empty-state"><b>No sections yet</b><button class="btn primary" data-act="seed-sections" style="margin-top:10px">Create the standard sections</button></div>`}
      ${gone.length ? `<div class="group"><h2>Hidden (removed before permanent delete existed)</h2><div class="tablewrap"><table class="t"><tbody>${gone.map(row).join('')}</tbody></table></div></div>` : ''}`;
  }

  // ------------------------------------------------------------ super admin: archive, back up, restore

  function archivePayload(s) {
    const items = S.items.filter((it) => it.sectionId === s.id);
    const ids = new Set(items.map((i) => i.id));
    const comments = S.comments.filter((c) => ids.has(c.itemId));
    const linked = {};
    const used = new Set();
    items.forEach((it) => {
      [it.createdBy].concat(it.editors || [], it.collaborators || [], (it.files || []).map((f) => f.uploadedBy)).forEach((u) => used.add(u));
      s.fields.forEach((f) => {
        const v = val(it, f);
        if (f.type === 'person' && v) used.add(v);
        if (f.type === 'link' && v && !ids.has(v) && item(v)) linked[v] = { title: item(v).title };
      });
    });
    comments.forEach((c) => used.add(c.author));
    const access = S.access.filter((a) => a.sectionId === s.id).map((a) => ({ userId: a.userId, level: a.level }));
    access.forEach((a) => used.add(a.userId));
    return {
      app: 'Sourcing Hub', appUrl: location.origin + location.pathname,
      exportedAt: new Date().toISOString(), exportedBy: S.me.id, exportedByName: S.me.name || S.me.id,
      section: { id: s.id, name: s.name, template: s.template || '', fields: s.fields, stageField: s.stageField || '' },
      items, comments, access, linked,
      users: S.users.filter((u) => used.has(u.id)).map((u) => ({ id: u.id, name: u.name })),
    };
  }

  function openArchiveExport(id, mode) {
    const s = section(id);
    if (!s || !S.me.isSuper) return;
    const items = S.items.filter((it) => it.sectionId === s.id);
    const files = items.reduce((t, it) => t + (it.files || []).length, 0);
    const comments = S.comments.filter((c) => items.some((it) => it.id === c.itemId)).length;
    const remove = mode === 'remove';
    S.drawer = { kind: 'archive', id, mode };
    drawerEl.innerHTML = `
      <div class="scrim" data-act="close-drawer"></div>
      <div class="pane" role="dialog" aria-modal="true" aria-labelledby="paneTitle">
        <div class="pane-h"><div><div class="k">Manage sections</div><h2 id="paneTitle">${remove ? 'Remove' : 'Back up'} ${esc(s.name)}</h2></div><button type="button" class="x" data-act="close-drawer" aria-label="Close">×</button></div>
        <div class="pane-b">
          <form id="archiveForm" class="form" novalidate>
            ${remove ? `<div class="banner danger wide"><span><b>This permanently deletes ${esc(s.name)}</b> and everything in it from the Google Sheet: ${items.length} items, ${comments} comments and activity entries, and ${S.access.filter((a) => a.sectionId === s.id).length} people’s access. Its Google Calendar events are deleted too. Only an archive file can bring it back.</span></div>` : ''}
            <div class="fld wide"><span>${remove ? 'The archive file will contain' : 'What goes into the file'}</span>
              <div class="arc-sum"><span><b>${items.length}</b> items</span><span><b>${comments}</b> comments and activity entries</span><span><b>${s.fields.length}</b> columns and stages</span><span><b>${S.access.filter((a) => a.sectionId === s.id).length}</b> people’s access</span><span><b>${files}</b> attachment records</span></div>
              <small class="muted">Attachments are listed with their names; the files themselves stay in the company Google Drive, so they still open after a restore.</small></div>
            ${remove ? `<label class="fld chk wide"><input type="checkbox" name="backup" checked><span><b>Download an archive file first</b> (strongly recommended)</span></label>` : `<div class="banner info wide"><span>You get one <b>.html</b> file. Double-click it to view the section in any browser, offline, without signing in. To bring it back, use <b>Restore from archive</b>.</span></div>`}
            <label class="fld"><span>Password for the file (optional)</span><input type="password" name="pw" autocomplete="new-password" placeholder="Leave empty for no password"></label>
            <label class="fld"><span>Repeat password</span><input type="password" name="pw2" autocomplete="new-password"></label>
            <small class="muted wide">With a password the file is encrypted (AES-256). Nobody can open or restore it without the password, and a lost password cannot be recovered.</small>
            ${remove ? `<label class="fld wide"><span>Type <b>${esc(s.name)}</b> to confirm</span><input type="text" name="confirmName" autocomplete="off"></label>` : ''}
            <div class="form-actions"><button type="submit" class="btn ${remove ? 'danger armed' : 'primary'}" id="saveBtn">${remove ? 'Delete permanently' : 'Download backup'}</button><button type="button" class="btn" data-act="close-drawer">Cancel</button></div>
          </form>
        </div>
      </div>`;
    openDrawer(remove ? 'input[name=backup]' : 'input[name=pw]');
  }

  function downloadArchive(s, html, mode) {
    const name = 'RFQHub_' + (s.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'Section') + '_' + (mode === 'remove' ? 'archive' : 'backup') + '_' + today() + '.html';
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return name;
  }

  async function runArchiveExport(form) {
    const { id, mode } = S.drawer;
    const s = section(id);
    const remove = mode === 'remove';
    const backup = !remove || form.elements.backup.checked;
    const pw = form.elements.pw.value;
    if (backup && pw !== form.elements.pw2.value) { toast('The two passwords do not match.', true); return; }
    if (backup && pw && pw.length < 6) { toast('Use a password of at least 6 characters.', true); return; }
    if (remove && form.elements.confirmName.value.trim().toLowerCase() !== s.name.trim().toLowerCase()) {
      toast('Type the section name exactly to confirm.', true);
      form.elements.confirmName.focus();
      return;
    }
    const btn = $('#saveBtn');
    btn.disabled = true;
    btn.textContent = backup ? 'Preparing the file…' : 'Deleting…';
    try {
      let file = '';
      if (backup) file = downloadArchive(s, await window.Archive.build(archivePayload(s), pw), mode);
      if (remove) {
        btn.textContent = 'Deleting…';
        const res = await API.call('section.delete', { id: s.id, confirmName: form.elements.confirmName.value });
        const gone = new Set(res.itemIds);
        S.sections = S.sections.filter((x) => x.id !== s.id);
        S.items = S.items.filter((it) => it.sectionId !== s.id);
        S.comments = S.comments.filter((c) => !gone.has(c.itemId));
        S.access = S.access.filter((a) => a.sectionId !== s.id);
        toast(s.name + ' deleted from the platform and the Google Sheet.' + (file ? ' Archive file downloaded.' : ''));
      } else {
        toast('Backup downloaded: ' + file);
      }
      closeDrawer();
      render();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = remove ? 'Delete permanently' : 'Download backup';
      handleError(e);
    }
  }

  function openArchiveRestore() {
    if (!S.me.isSuper) return;
    S.drawer = { kind: 'restore', box: null, payload: null };
    renderRestore();
  }

  function renderRestore(message) {
    const d = S.drawer;
    const p = d.payload;
    const taken = p && S.sections.some((s) => s.name.toLowerCase() === p.section.name.toLowerCase());
    const people = p ? p.access.filter((a) => S.users.some((u) => u.id === a.userId) && !Core.isSuperId(a.userId)) : [];
    drawerEl.innerHTML = `
      <div class="scrim" data-act="close-drawer"></div>
      <div class="pane" role="dialog" aria-modal="true" aria-labelledby="paneTitle">
        <div class="pane-h"><div><div class="k">Manage sections</div><h2 id="paneTitle">Restore from archive</h2></div><button type="button" class="x" data-act="close-drawer" aria-label="Close">×</button></div>
        <div class="pane-b">
          <form id="restoreForm" class="form" novalidate>
            <label class="fld wide"><span>Archive file (.html)</span><input type="file" id="arcFile" accept=".html,text/html"></label>
            ${message ? `<div class="banner wide"><span>${esc(message)}</span></div>` : ''}
            ${d.box && d.box.encrypted && !p ? `
              <div class="banner info wide"><span><b>${esc(d.box.meta.section)}</b> · ${esc(d.box.meta.items)} items · exported ${esc(fmtDate(d.box.meta.exportedAt))} by ${esc(d.box.meta.exportedBy)}. This file is password protected.</span></div>
              <label class="fld wide"><span>Password</span><input type="password" name="pw" autocomplete="current-password"></label>
              <div class="form-actions"><button type="button" class="btn primary" data-act="arc-unlock">Unlock</button></div>` : ''}
            ${p ? `
              <div class="fld wide"><span>In this archive</span><div class="arc-sum"><span><b>${p.items.length}</b> items</span><span><b>${p.comments.length}</b> comments and activity</span><span><b>${p.section.fields.length}</b> columns</span><span>exported ${esc(fmtDate(p.exportedAt))} by ${esc(p.exportedByName)}</span></div></div>
              <label class="fld wide"><span>Restore as a new section named</span><input type="text" name="name" value="${esc(taken ? p.section.name + ' (restored)' : p.section.name)}"></label>
              ${taken ? '<small class="muted wide">A section with this name already exists. Nothing in it will change; the archive comes back as a separate copy.</small>'
                : '<small class="muted wide">The section and its items are written back into the Google Sheet. If the original was deleted, links from other sections, shared item links and calendar events reconnect.</small>'}
              <label class="fld chk wide"><input type="checkbox" name="withAccess"${people.length ? ' checked' : ' disabled'}><span>Give back people’s access (${people.length} ${people.length === 1 ? 'person' : 'people'} who still have accounts)</span></label>
              <small class="muted wide">Editors and collaborators who no longer have an account are left off. Attachments point to the same Google Drive files as before.</small>
              <div class="form-actions"><button type="submit" class="btn primary" id="saveBtn">Restore section</button><button type="button" class="btn" data-act="close-drawer">Cancel</button></div>` : ''}
          </form>
        </div>
      </div>`;
    openDrawer(p ? 'input[name=name]' : d.box && d.box.encrypted ? 'input[name=pw]' : '#arcFile');
  }

  async function readArchiveFile(file) {
    try {
      const box = window.Archive.read(await file.text());
      S.drawer.box = box;
      S.drawer.payload = box.encrypted ? null : box.payload;
      renderRestore();
    } catch (e) {
      S.drawer.box = null;
      S.drawer.payload = null;
      renderRestore(e.message);
    }
  }

  async function unlockArchive() {
    const pw = (drawerEl.querySelector('input[name=pw]') || {}).value || '';
    try {
      S.drawer.payload = await window.Archive.open(S.drawer.box, pw);
      renderRestore();
    } catch (e) {
      renderRestore(e.message);
    }
  }

  async function runRestore(form) {
    const p = S.drawer.payload;
    const name = form.elements.name.value.trim();
    if (!name) { toast('Give the section a name.', true); return; }
    const btn = $('#saveBtn');
    btn.disabled = true;
    btn.textContent = 'Restoring ' + p.items.length + ' items…';
    try {
      const res = await API.call('section.restore', {
        name, section: p.section, items: p.items, comments: p.comments, access: p.access, withAccess: form.elements.withAccess.checked,
      });
      replaceSection(res.section);
      S.items = S.items.concat(res.items);
      S.comments = S.comments.concat(res.comments);
      S.access = S.access.concat(res.access);
      closeDrawer();
      toast(name + ' restored into the platform and the Google Sheet: ' + res.items.length + ' items' + (res.reusedIds ? '. Links from other sections reconnected.' : ''));
      location.hash = '#s/' + res.section.id;
      render();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Restore section';
      handleError(e);
    }
  }

  // ------------------------------------------------------------ super admin: users & access

  function viewTeam() {
    if (!S.me.isSuper) return '<div class="empty-state"><b>Super admin only</b></div>';
    const secs = liveSections();
    const people = S.users.slice().sort((a, b) => (Core.isSuperId(b.id) - Core.isSuperId(a.id)) || (a.name || a.id).localeCompare(b.name || b.id));
    const lvl = (sid, uid) => { const a = S.access.find((x) => x.sectionId === sid && x.userId === uid); return a ? a.level : 'none'; };
    const matrix = people.map((u) => `<tr>
      <td class="nw sticky"><button class="linkrow" data-act="user-edit" data-id="${esc(u.id)}">${avatar(u.id)} <span><b>${esc(u.name || u.id)}</b><small>${esc(u.id)}</small></span></button></td>
      <td class="nw">${Core.isSuperId(u.id) ? '<span class="chip info">Super admin</span>' : u.active ? '<span class="chip ok">Active</span>' : '<span class="chip">Switched off</span>'}</td>
      ${secs.map((s) => Core.isSuperId(u.id) ? '<td class="nw muted">Full access</td>'
        : `<td><select class="lvl lvl-${lvl(s.id, u.id)}" data-access="${esc(s.id)}|${esc(u.id)}" aria-label="${esc((u.name || u.id) + ' — ' + s.name)}">${Core.LEVELS.map((l) => `<option value="${l}"${lvl(s.id, u.id) === l ? ' selected' : ''}>${l === 'none' ? '—' : LEVEL_LABEL[l]}</option>`).join('')}</select></td>`).join('')}
    </tr>`).join('');
    return `
      <div class="head"><div><h1>Users &amp; access</h1><div class="sub">Only accounts listed here can sign in. Set each person’s access per section; their dashboard shows only the sections they can open.</div></div>
        <button class="btn primary" data-act="user-new">+ Add user</button></div>
      <div class="legend-box">${['viewer', 'contributor', 'editor', 'manager'].map((l) => `<span><b>${LEVEL_LABEL[l]}</b> ${LEVEL_HELP[l]}</span>`).join('')}
        <span><b>—</b> no access to the section, but they still see items where they are named as an editor or collaborator</span></div>
      ${secs.length ? '' : '<div class="banner"><span>Create a section first, then give people access to it.</span></div>'}
      <div class="tablewrap"><table class="t matrix"><thead><tr><th class="sticky">User</th><th>Status</th>${secs.map((s) => `<th>${esc(s.name)}</th>`).join('')}</tr></thead><tbody>${matrix}</tbody></table></div>`;
  }

  // ------------------------------------------------------------ customize columns

  function viewCustomize(id) {
    const s = section(id);
    if (!s) return '<div class="empty-state"><b>Section not found</b><a href="#sections">Back</a></div>';
    if (!can.template(ctx(), s)) return `<div class="empty-state"><b>You cannot change this section’s columns</b>Only the super admin and the section’s managers can. <a href="#s/${esc(id)}">Back to ${esc(s.name)}</a></div>`;
    if (!S.tpl || S.tpl.id !== id) S.tpl = { id, name: s.name, stageField: s.stageField || '', fields: JSON.parse(JSON.stringify(s.fields)), armed: null };
    const t = S.tpl;
    const selects = t.fields.filter((f) => f.type === 'select');
    const otherSecs = liveSections().filter((x) => x.id !== id);
    const fieldRow = (f, i) => {
      const isTitle = f.key === 'title';
      const isStage = f.key === t.stageField;
      const flags = [];
      if (!isTitle) flags.push(flag(i, 'required', 'Required', f.required));
      if (!isTitle && !isStage) flags.push(flag(i, 'onCard', 'Show on card', f.onCard));
      if (f.type === 'date' || f.type === 'datetime') flags.push(flag(i, 'due', 'Deadline (late alerts)', f.due));
      if (f.type === 'currency' || f.type === 'number') flags.push(flag(i, 'total', 'Show totals', f.total));
      return `<div class="tf${isStage ? ' stage' : ''}">
        <div class="tf-row">
          <span class="tf-n">${i + 1}</span>
          <label class="fld grow"><span>Column name</span><input type="text" value="${esc(f.label)}" data-tf="${i}" data-prop="label" aria-label="Column name"></label>
          <label class="fld"><span>Type</span><select data-tf="${i}" data-prop="type"${isTitle ? ' disabled' : ''}>${Core.FIELD_TYPES.map((ty) => `<option value="${ty}"${f.type === ty ? ' selected' : ''}>${TYPE_LABEL[ty]}</option>`).join('')}</select></label>
          <div class="tf-act">
            <button type="button" class="ibtn" data-act="tpl-move" data-i="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
            <button type="button" class="ibtn" data-act="tpl-move" data-i="${i}" data-dir="1" ${i === t.fields.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
            ${isTitle ? '<span class="chip">Always shown</span>' : `<button type="button" class="btn sm danger${t.armed === f.key ? ' armed' : ''}" data-act="tpl-del" data-i="${i}">${t.armed === f.key ? 'Click again' : 'Remove'}</button>`}
          </div>
        </div>
        ${flags.length ? `<div class="tf-flags">${flags.join('')}${isStage ? '<span class="chip info">Board columns</span>' : ''}</div>` : ''}
        ${f.type === 'link' ? `<label class="fld" style="max-width:320px"><span>Links to section</span><select data-tf="${i}" data-prop="target"><option value="">Choose a section</option>${otherSecs.map((x) => `<option value="${esc(x.id)}"${f.target === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>` : ''}
        ${f.type === 'select' ? `<div class="opts">
          <div class="opts-h"><span>Options</span>${isStage ? '<span class="muted">Alert after = days an item may stay in this stage before it is flagged. Deadline met = still open, but the due date no longer matters (e.g. submitted). Done = finished, no late alerts.</span>' : ''}</div>
          ${(f.options || []).map((o, j) => `<div class="opt">
            <span class="dot f-${o.color}"></span>
            <input type="text" value="${esc(o.label)}" data-to="${i}.${j}" data-prop="label" aria-label="Option name">
            <select data-to="${i}.${j}" data-prop="color" aria-label="Colour">${Core.COLORS.map((c) => `<option value="${c}"${o.color === c ? ' selected' : ''}>${COLOR_LABEL[c]}</option>`).join('')}</select>
            ${isStage ? `<label class="mini">Alert after <input type="number" min="0" max="365" value="${o.alertDays || ''}" data-to="${i}.${j}" data-prop="alertDays" aria-label="Alert after days"> d</label>
              <label class="mini"><input type="checkbox" ${o.met ? 'checked' : ''} data-to="${i}.${j}" data-prop="met"> Deadline met</label>
              <label class="mini"><input type="checkbox" ${o.done ? 'checked' : ''} data-to="${i}.${j}" data-prop="done"> Done</label>` : ''}
            <button type="button" class="ibtn" data-act="opt-move" data-i="${i}" data-j="${j}" data-dir="-1" ${j === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
            <button type="button" class="ibtn" data-act="opt-move" data-i="${i}" data-j="${j}" data-dir="1" ${j === f.options.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
            <button type="button" class="ibtn" data-act="opt-del" data-i="${i}" data-j="${j}" aria-label="Remove option">×</button>
          </div>`).join('')}
          <button type="button" class="btn sm" data-act="opt-add" data-i="${i}">+ Add option</button>
        </div>` : ''}
      </div>`;
    };
    return `
      <div class="head"><div><div class="crumb"><a href="#s/${esc(id)}">${esc(s.name)}</a> / Customize</div><h1>Customize columns</h1>
        <div class="sub">Changes apply for everyone as soon as you save. Removing a column hides it; the values already entered stay in the Google Sheet.</div></div>
        <div class="toolbar"><a class="btn" href="#s/${esc(id)}" data-act="tpl-cancel">Cancel</a><button class="btn primary" data-act="tpl-save" id="tplSave">Save columns</button></div></div>
      <section class="panel">
        <div class="form">
          <label class="fld"><span>Section name</span><input type="text" value="${esc(t.name)}" data-tpl="name"></label>
          <label class="fld"><span>Board columns come from</span><select data-tpl="stageField"><option value="">No board — table only</option>${selects.map((f) => `<option value="${esc(f.key)}"${t.stageField === f.key ? ' selected' : ''}>${esc(f.label)}</option>`).join('')}</select></label>
        </div>
      </section>
      <div class="tfs">${t.fields.map(fieldRow).join('')}</div>
      <div class="toolbar"><button type="button" class="btn" data-act="tpl-add">+ Add column</button><span class="grow"></span><button class="btn primary" data-act="tpl-save">Save columns</button></div>`;
  }
  function flag(i, prop, label, on) {
    return `<label class="mini"><input type="checkbox" data-tf="${i}" data-prop="${prop}"${on ? ' checked' : ''}> ${label}</label>`;
  }

  function rerenderTpl() {
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  }

  async function saveTemplate() {
    const t = S.tpl;
    if (!t.name.trim()) { toast('Give the section a name.', true); return; }
    for (const f of t.fields) {
      if (!f.label.trim()) { toast('Every column needs a name.', true); return; }
      if (f.type === 'select' && !(f.options || []).some((o) => o.label.trim())) { toast('“' + f.label + '” needs at least one option.', true); return; }
      if (f.type === 'link' && !f.target) { toast('Choose which section “' + f.label + '” links to.', true); return; }
    }
    const fields = t.fields.map((f) => {
      const o = Object.assign({}, f);
      if (o.type === 'select') o.options = o.options.filter((x) => x.label.trim()).map((x) => Object.assign({}, x, { value: x.value || 'o' + uid() }));
      else delete o.options;
      if (o.type !== 'link') delete o.target;
      return o;
    });
    document.querySelectorAll('[data-act="tpl-save"]').forEach((b) => { b.disabled = true; b.textContent = 'Saving…'; });
    try {
      const res = await API.call('section.update', { id: t.id, patch: { name: t.name.trim(), fields, stageField: t.stageField } });
      replaceSection(res.section);
      S.tpl = null;
      toast('Columns saved');
      location.hash = '#s/' + t.id;
    } catch (e) {
      document.querySelectorAll('[data-act="tpl-save"]').forEach((b) => { b.disabled = false; b.textContent = 'Save columns'; });
      handleError(e);
    }
  }

  function replaceSection(sec) {
    const i = S.sections.findIndex((s) => s.id === sec.id);
    if (i >= 0) S.sections[i] = sec; else S.sections.push(sec);
    S.sections.sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  // ------------------------------------------------------------ drawer: item

  function inputFor(s, f, v, ro) {
    const id = 'f_' + f.key;
    const dis = ro ? ' disabled' : '';
    const req = f.required ? ' required' : '';
    switch (f.type) {
      case 'longtext': return `<textarea id="${id}" name="${f.key}"${dis}>${esc(v)}</textarea>`;
      case 'number': case 'percent': return `<input type="number" id="${id}" name="${f.key}" step="any" value="${blank(v) ? '' : esc(v)}"${dis}${req}>`;
      case 'currency': return `<input type="number" id="${id}" name="${f.key}" step="0.01" inputmode="decimal" value="${blank(v) ? '' : esc(v)}"${dis}${req}>`;
      case 'date': return `<input type="date" id="${id}" name="${f.key}" value="${esc(String(v || '').slice(0, 10))}"${dis}${req}>`;
      case 'datetime': return `<input type="datetime-local" id="${id}" name="${f.key}" value="${esc(String(v || '').slice(0, 16))}"${dis}${req}>`;
      case 'select': return `<select id="${id}" name="${f.key}"${dis}${req}><option value="">—</option>${(f.options || []).map((o) => `<option value="${esc(o.value)}"${o.value === v ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
      case 'person': return `<select id="${id}" name="${f.key}"${dis}${req}><option value="">Nobody</option>${S.users.filter((u) => u.active || u.id === v).map((u) => `<option value="${esc(u.id)}"${u.id === v ? ' selected' : ''}>${esc(u.name || u.id)}</option>`).join('')}</select>`;
      case 'checkbox': return `<input type="checkbox" id="${id}" name="${f.key}"${v ? ' checked' : ''}${dis}>`;
      case 'link': {
        const targets = S.items.filter((x) => x.sectionId === f.target);
        return `<select id="${id}" name="${f.key}"${dis}${req}><option value="">—</option>${targets.map((x) => `<option value="${esc(x.id)}"${x.id === v ? ' selected' : ''}>${esc(x.title)}</option>`).join('')}${v && !item(v) ? `<option value="${esc(v)}" selected>(an item you cannot see)</option>` : ''}</select>`;
      }
      case 'url': return `<input type="url" id="${id}" name="${f.key}" value="${esc(v)}" placeholder="https://"${dis}${req}>`;
      default: return `<input type="text" id="${id}" name="${f.key}" value="${esc(v)}"${dis}${req}>`;
    }
  }

  function picker(name, label, chosen, ro, hint) {
    const people = S.users.filter((u) => u.active || chosen.includes(u.id));
    return `<div class="fld wide"><span>${label}</span>
      <details class="pick"${ro ? ' data-ro="1"' : ''}>
        <summary>${chosen.length ? chosen.map((id) => `<span class="pchip">${avatar(id)}${esc(userName(id))}</span>`).join('') : `<span class="muted">${ro ? 'Nobody' : 'Choose people'}</span>`}</summary>
        ${ro ? '' : `<div class="pick-b"><input type="search" placeholder="Find a person" data-pick-filter aria-label="Find a person">
          ${people.map((u) => `<label class="prow"><input type="checkbox" name="${name}" value="${esc(u.id)}"${chosen.includes(u.id) ? ' checked' : ''}> ${avatar(u.id)} <span>${esc(u.name || u.id)}</span><small>${esc(u.id)}</small></label>`).join('')}</div>`}
      </details>${hint ? `<small class="muted">${hint}</small>` : ''}</div>`;
  }

  function openItem(id, full) {
    const it = item(id);
    if (!it) { toast('You cannot open this item. It was deleted, or you do not have access — ask a section manager or one of its editors to add you.', true); return; }
    let remembered = false;
    try { remembered = localStorage.getItem('sourcinghub_full') === '1'; } catch (e) { /* storage blocked */ }
    S.drawer = { kind: 'item', id: it.id, sectionId: it.sectionId, armed: false, busy: false, full: full || remembered };
    renderItemDrawer(it);
  }
  const itemLink = (id) => location.origin + location.pathname + '#item/' + encodeURIComponent(id);

  async function copyLink(id, btn) {
    const url = itemLink(id);
    try {
      await navigator.clipboard.writeText(url);
    } catch (e) {
      // Clipboard blocked: show the link selected so it can be copied by hand
      const box = $('#shareBox');
      if (box) { box.hidden = false; const inp = box.querySelector('input'); inp.value = url; inp.select(); }
      toast('Press Ctrl + C to copy the selected link.');
      return;
    }
    if (btn) { btn.textContent = 'Link copied ✓'; setTimeout(() => { if (btn.isConnected) btn.textContent = 'Copy link'; }, 2000); }
    toast('Link copied. Only people with access to this item can open it.');
  }
  function newItem(sectionId, preset) {
    const s = section(sectionId);
    const data = Object.assign({}, preset || {});
    const sf = stageF(s);
    if (sf && !data[sf.key] && sf.options[0]) data[sf.key] = sf.options[0].value;
    S.drawer = { kind: 'item', id: null, sectionId, armed: false, busy: false };
    renderItemDrawer({ title: '', data, editors: [], collaborators: [], files: [] });
  }

  function renderItemDrawer(it) {
    const s = section(S.drawer.sectionId);
    const isNew = !S.drawer.id;
    const editable = isNew ? can.create(ctx(), s) : can.editItem(ctx(), it, s);
    const ro = !editable;
    const commentable = !isNew && can.comment(ctx(), it, s);
    const thread = isNew ? [] : S.comments.filter((c) => c.itemId === it.id).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    const related = isNew ? [] : liveSections().flatMap((s2) => s2.fields.filter((f) => f.type === 'link' && f.target === s.id).map((f) => ({ s2, f, items: S.items.filter((x) => x.sectionId === s2.id && val(x, f) === it.id) })));
    const fields = s.fields;
    drawerEl.innerHTML = `
      <div class="scrim" data-act="close-drawer"></div>
      <div class="pane" role="dialog" aria-modal="true" aria-labelledby="paneTitle">
        <div class="pane-h"><div style="min-width:0"><div class="k">${esc(s.name)}</div><h2 id="paneTitle">${isNew ? 'New item' : esc(it.title)}</h2>
          ${!isNew ? `<div class="muted" style="font-size:12px">Updated ${ago(it.updatedAt)}${roleOn(it) ? ' · you are ' + esc(roleOn(it).toLowerCase()) : ''}</div>` : ''}</div>
          <div class="pane-tools">
            ${!isNew ? `<button type="button" class="btn sm" data-act="copy-link" title="Copy a link to this item. Only people with access can open it.">Copy link</button>` : ''}
            <button type="button" class="btn sm" data-act="full-toggle" title="${S.drawer.full ? 'Back to side panel' : 'Open full screen'}">${S.drawer.full ? '⤡ Exit full screen' : '⤢ Full screen'}</button>
            <button type="button" class="x" data-act="close-drawer" aria-label="Close">×</button>
          </div></div>
        ${!isNew ? `<div class="sharebox" id="shareBox" hidden><input type="text" readonly aria-label="Link to this item"><span>Only people with access to ${esc(s.name)}, or named on this item, can open it.</span></div>` : ''}
        <div class="pane-b">
          <div class="pb-main">
          <form class="form" id="itemForm" novalidate>
            ${fields.map((f) => `<label class="fld${f.type === 'longtext' || f.key === 'title' ? ' wide' : ''}${f.type === 'checkbox' ? ' chk' : ''}">${f.type === 'checkbox' ? inputFor(s, f, val(it, f), ro) + `<span>${esc(f.label)}</span>` : `<span>${esc(f.label)}${f.required ? ' *' : ''}</span>${inputFor(s, f, val(it, f), ro)}`}</label>`).join('')}
            ${picker('editors', 'Editors', it.editors || [], ro, 'Editors can change this item, even without access to the whole section.')}
            ${picker('collaborators', 'Collaborators', it.collaborators || [], ro, 'Collaborators can see this item and comment on it.')}
            <div class="form-actions">
              ${ro ? '<span class="muted">You can view this item but not change it.</span>' : `<button type="submit" class="btn primary" id="saveBtn">${isNew ? 'Add item' : 'Save changes'}</button><button type="button" class="btn" data-act="close-drawer">Cancel</button>`}
              <span class="sp"></span>
              ${!isNew && can.deleteItem(ctx(), it, s) ? `<button type="button" class="btn danger${S.drawer.armed ? ' armed' : ''}" data-act="item-delete">${S.drawer.armed ? 'Click again to delete' : 'Delete'}</button>` : ''}
            </div>
          </form>
          </div>
          <div class="pb-side">
          ${related.map((r) => `<section class="sec"><h3>${esc(r.s2.name)} <span class="muted" style="text-transform:none;letter-spacing:0">${r.items.length}${r.s2.fields.filter((f) => f.total).map((f) => ' · ' + esc(f.label) + ' ' + moneyShortOrNum(f, sum(r.items, (x) => val(x, f)))).join('')}</span>
              ${can.create(ctx(), r.s2) ? `<button type="button" class="btn sm" data-act="new-linked" data-section="${esc(r.s2.id)}" data-field="${esc(r.f.key)}" data-target="${esc(it.id)}">+ Add</button>` : ''}</h3>
            ${r.items.length ? `<ul class="rel">${r.items.sort(byDue).map((x) => `<li data-act="open" data-id="${esc(x.id)}"><span>${esc(x.title)}</span>${stageOpt(r.s2, x) ? `<span class="chip c-${stageOpt(r.s2, x).color}">${esc(stageOpt(r.s2, x).label)}</span>` : ''}${chip(dueInfo(r.s2, x))}</li>`).join('')}</ul>` : '<div class="muted">None you can see.</div>'}
          </section>`).join('')}
          ${!isNew ? `
            <section class="sec"><h3>Attachments ${editable ? `<button type="button" class="btn sm" data-act="upload"${S.drawer.busy ? ' disabled' : ''}>${S.drawer.busy ? 'Uploading…' : 'Attach file'}</button>` : ''}</h3>
              <input type="file" id="fileInput" hidden>
              ${(it.files || []).length ? `<ul class="files">${it.files.map((fl) => `<li>📄 <button type="button" class="linkbtn" data-act="file-open" data-file="${esc(fl.id)}">${esc(fl.name)}</button><small>${fl.size ? Math.max(1, Math.round(fl.size / 1024)) + ' KB · ' : ''}${esc(userName(fl.uploadedBy))} · ${ago(fl.uploadedAt)}</small></li>`).join('')}</ul>`
                : `<div class="muted">No files yet.${API.mode === 'demo' ? ' Attachments are stored in Google Drive once it is connected.' : ''}</div>`}
            </section>
            <section class="sec"><h3>Comments &amp; activity</h3>
              <div class="thread">${thread.length ? thread.map((c) => c.kind === 'log'
                ? `<div class="msg log"><span class="dot"></span><div>${esc(userName(c.author))} ${esc(c.text)} · ${ago(c.createdAt)}</div></div>`
                : `<div class="msg">${avatar(c.author)}<div class="bd"><div class="hd"><b>${esc(userName(c.author))}</b> · ${ago(c.createdAt)}</div><div class="tx">${esc(c.text)}</div></div></div>`).join('')
                : '<div class="muted">No comments yet.</div>'}</div>
              ${commentable ? '<div class="composer"><textarea id="commentText" placeholder="Write an update or ask a question…" aria-label="Comment"></textarea><button type="button" class="btn sm" data-act="add-comment">Post comment</button></div>' : ''}
            </section>` : ''}
          </div>
        </div>
      </div>`;
    drawerEl.classList.toggle('full', !!S.drawer.full);
    openDrawer(isNew ? '#itemForm input:not([disabled])' : '.x');
  }

  /** Switch the open item between side panel and full screen; only styling changes, so typed input stays. */
  function toggleFull(btn) {
    S.drawer.full = !S.drawer.full;
    drawerEl.classList.toggle('full', S.drawer.full);
    btn.textContent = S.drawer.full ? '⤡ Exit full screen' : '⤢ Full screen';
    btn.title = S.drawer.full ? 'Back to side panel' : 'Open full screen';
    try { localStorage.setItem('sourcinghub_full', S.drawer.full ? '1' : ''); } catch (e) { /* storage blocked */ }
  }

  function openDrawer(focusSel) {
    drawerEl.hidden = false;
    document.body.style.overflow = 'hidden';
    const first = drawerEl.querySelector(focusSel);
    if (first) first.focus();
  }
  function closeDrawer() {
    S.drawer = null;
    drawerEl.classList.remove('full');
    drawerEl.hidden = true;
    drawerEl.innerHTML = '';
    document.body.style.overflow = '';
  }

  function mergeItem(res) {
    const it = res.item;
    const i = S.items.findIndex((x) => x.id === it.id);
    if (i >= 0) S.items[i] = it; else S.items.push(it);
    if (res.log) S.comments.push(res.log);
    return it;
  }

  async function saveItem(form) {
    const s = section(S.drawer.sectionId);
    const isNew = !S.drawer.id;
    const data = {};
    let title = '';
    for (const f of s.fields) {
      const el = form.elements[f.key];
      if (!el) continue;
      let v = f.type === 'checkbox' ? el.checked : el.value.trim();
      if (['number', 'currency', 'percent'].includes(f.type)) v = v === '' ? '' : Number(v);
      if (f.required && (v === '' || v === false)) { toast(f.label + ' is required.', true); el.focus(); return; }
      if (f.key === 'title') title = v; else data[f.key] = v;
    }
    const pick = (n) => [...form.querySelectorAll(`input[name="${n}"]:checked`)].map((x) => x.value);
    const editors = pick('editors');
    const collaborators = pick('collaborators').filter((x) => !editors.includes(x));
    const btn = $('#saveBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      if (isNew) {
        const res = await API.call('item.create', { sectionId: s.id, title, data, editors, collaborators });
        mergeItem(res);
        toast('Item added');
      } else {
        const res = await API.call('item.update', { id: S.drawer.id, patch: { title, data, editors, collaborators } });
        mergeItem(res);
        toast('Saved');
      }
      closeDrawer();
      render();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = isNew ? 'Add item' : 'Save changes'; }
      handleError(e);
    }
  }

  async function deleteItem() {
    if (!S.drawer.armed) { S.drawer.armed = true; renderItemDrawer(item(S.drawer.id)); return; }
    const id = S.drawer.id;
    try {
      await API.call('item.remove', { id });
      S.items = S.items.filter((x) => x.id !== id);
      S.comments = S.comments.filter((c) => c.itemId !== id);
      closeDrawer();
      toast('Item deleted');
      render();
    } catch (e) { handleError(e); }
  }

  async function addComment() {
    const ta = $('#commentText');
    const text = ta && ta.value.trim();
    if (!text) return;
    ta.disabled = true;
    try {
      const res = await API.call('comment.create', { itemId: S.drawer.id, text });
      S.comments.push(res.comment);
      renderItemDrawer(item(S.drawer.id));
      render();
    } catch (e) { ta.disabled = false; handleError(e); }
  }

  async function uploadFile(file) {
    const id = S.drawer.id;
    if (file.size > 20 * 1024 * 1024) { toast('Files must be 20 MB or smaller.', true); return; }
    S.drawer.busy = true;
    renderItemDrawer(item(id));
    try {
      mergeItem(await API.upload(id, file));
      toast('File attached');
    } catch (e) { handleError(e); }
    if (S.drawer && S.drawer.id === id) { S.drawer.busy = false; renderItemDrawer(item(id)); }
    render();
  }

  async function openFile(fileId) {
    try {
      toast('Opening file…');
      const f = await API.call('item.file', { id: S.drawer.id, fileId });
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: f.mimeType || 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name || 'file';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) { handleError(e); }
  }

  async function moveItem(id, stage) {
    const it = item(id);
    const s = it && sectionOf(it);
    if (!it || !s || !s.stageField || (it.data || {})[s.stageField] === stage) return;
    const before = JSON.parse(JSON.stringify(it));
    it.data = Object.assign({}, it.data, { [s.stageField]: stage });
    render();
    try {
      mergeItem(await API.call('item.update', { id, patch: { data: { [s.stageField]: stage } } }));
      const o = optOf(stageF(s), stage);
      toast('Moved to ' + (o ? o.label : 'no stage'));
      render();
    } catch (e) {
      mergeItem({ item: before });
      render();
      handleError(e);
    }
  }

  // ------------------------------------------------------------ drawer: user, new section

  function openUser(id, armed) {
    const u = id ? user(id) : { id: '', name: '', active: true };
    const isSuperRow = Core.isSuperId(u.id);
    S.drawer = { kind: 'user', id: id || null, armed: !!armed };
    const secs = liveSections();
    const lvl = (sid) => { const a = S.access.find((x) => x.sectionId === sid && x.userId === u.id); return a ? a.level : 'none'; };
    drawerEl.innerHTML = `
      <div class="scrim" data-act="close-drawer"></div>
      <div class="pane" role="dialog" aria-modal="true" aria-labelledby="paneTitle">
        <div class="pane-h"><div><div class="k">User</div><h2 id="paneTitle">${id ? esc(u.name || u.id) : 'Add user'}</h2></div><button type="button" class="x" data-act="close-drawer" aria-label="Close">×</button></div>
        <div class="pane-b">
          <form class="form" id="userForm" novalidate>
            <label class="fld wide"><span>Google email *</span><input type="email" name="email" value="${esc(u.id)}" autocomplete="off"${id ? ' disabled' : ' required'}></label>
            <label class="fld wide"><span>Name</span><input type="text" name="name" value="${esc(u.name)}" placeholder="Filled in from Google at first sign-in if left empty"></label>
            <label class="fld chk wide"><input type="checkbox" name="active"${u.active !== false ? ' checked' : ''}${isSuperRow ? ' disabled' : ''}><span>Can sign in</span></label>
            ${!isSuperRow && secs.length ? `<div class="fld wide"><span>Section access</span><div class="acc-list">${secs.map((s) => `<label class="acc">${secMark(s)}<span>${esc(s.name)}</span><select name="acc_${esc(s.id)}">${Core.LEVELS.map((l) => `<option value="${l}"${lvl(s.id) === l ? ' selected' : ''}>${l === 'none' ? 'No access' : LEVEL_LABEL[l]}</option>`).join('')}</select></label>`).join('')}</div></div>` : ''}
            ${isSuperRow ? '<div class="banner wide"><span>Super admins always have full access and cannot be switched off.</span></div>' : ''}
            <div class="form-actions">
              <button type="submit" class="btn primary" id="saveBtn">${id ? 'Save changes' : 'Add user'}</button><button type="button" class="btn" data-act="close-drawer">Cancel</button>
              <span class="sp"></span>
              ${id && !isSuperRow ? `<button type="button" class="btn danger${S.drawer.armed ? ' armed' : ''}" data-act="user-delete">${S.drawer.armed ? 'Click again to delete' : 'Delete user'}</button>` : ''}
            </div>
          </form>
        </div>
      </div>`;
    openDrawer(id ? 'input[name=name]' : 'input[name=email]');
  }

  async function saveUser(form) {
    const id = S.drawer.id;
    const email = id || form.elements.email.value.trim().toLowerCase();
    const name = form.elements.name.value.trim();
    const active = form.elements.active.checked;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('Enter a valid Google email.', true); return; }
    const btn = $('#saveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const res = id ? await API.call('user.update', { id, patch: { name, active: Core.isSuperId(email) ? true : active } })
        : await API.call('user.create', { id: email, name, active });
      const i = S.users.findIndex((u) => u.id === res.user.id);
      if (i >= 0) S.users[i] = res.user; else S.users.push(res.user);
      for (const s of liveSections()) {
        const sel = form.elements['acc_' + s.id];
        if (!sel) continue;
        const cur = (S.access.find((a) => a.sectionId === s.id && a.userId === email) || {}).level || 'none';
        if (sel.value !== cur) await setAccess(s.id, email, sel.value, true);
      }
      closeDrawer();
      toast(id ? 'User saved' : 'User added');
      render();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = id ? 'Save changes' : 'Add user';
      handleError(e);
    }
  }

  async function setAccess(sectionId, userId, level, quiet) {
    const res = await API.call('access.set', { sectionId, userId, level });
    S.access = S.access.filter((a) => !(a.sectionId === sectionId && a.userId === userId));
    if (res.access) S.access.push(res.access);
    if (!quiet) toast(userName(userId) + ': ' + LEVEL_LABEL[level] + ' on ' + section(sectionId).name);
  }

  function openNewSection() {
    S.drawer = { kind: 'section' };
    drawerEl.innerHTML = `
      <div class="scrim" data-act="close-drawer"></div>
      <div class="pane" role="dialog" aria-modal="true" aria-labelledby="paneTitle">
        <div class="pane-h"><div><div class="k">Manage sections</div><h2 id="paneTitle">New section</h2></div><button type="button" class="x" data-act="close-drawer" aria-label="Close">×</button></div>
        <div class="pane-b">
          <form class="form" id="sectionForm" novalidate>
            <label class="fld wide"><span>Section name</span><input type="text" name="name" placeholder="e.g. Sourcing Hub" required></label>
            <div class="fld wide"><span>Start from</span><div class="tpl-list">
              <label class="tpl"><input type="radio" name="tpl" value="" checked><span><b>Blank</b><small>A title and a To Do / In Progress / Done status. Add your own columns next.</small></span></label>
              ${window.TEMPLATES.map((t) => `<label class="tpl"><input type="radio" name="tpl" value="${t.id}"><span><b>${esc(t.name)}</b><small>${esc(t.blurb)} ${t.fields.length} columns.</small></span></label>`).join('')}
            </div></div>
            <div class="form-actions"><button type="submit" class="btn primary" id="saveBtn">Create section</button><button type="button" class="btn" data-act="close-drawer">Cancel</button></div>
          </form>
        </div>
      </div>`;
    openDrawer('input[name=name]');
  }

  function blankSection(name) {
    return {
      name, template: '', stageField: 'status',
      fields: [
        { key: 'title', label: 'Title', type: 'text', required: true, system: true, onCard: true },
        { key: 'status', label: 'Status', type: 'select', options: [{ value: 'todo', label: 'To Do', color: 'gray' }, { value: 'doing', label: 'In Progress', color: 'blue' }, { value: 'done', label: 'Done', color: 'green', done: true }] },
        { key: 'dueDate', label: 'Due date', type: 'date', due: true, onCard: true },
        { key: 'notes', label: 'Notes', type: 'longtext' },
      ],
    };
  }

  async function createSection(form) {
    const tplId = (form.querySelector('input[name=tpl]:checked') || {}).value || '';
    const tpl = window.TEMPLATES.find((t) => t.id === tplId);
    const name = form.elements.name.value.trim() || (tpl ? tpl.name : '');
    if (!name) { toast('Give the section a name.', true); return; }
    const spec = tpl ? Object.assign(window.sectionFromTemplate(tpl, S.sections), { name }) : blankSection(name);
    const btn = $('#saveBtn');
    btn.disabled = true;
    try {
      const res = await API.call('section.create', spec);
      res.section.myLevel = 'manager';
      replaceSection(res.section);
      closeDrawer();
      toast('Section created');
      location.hash = tpl ? '#s/' + res.section.id : '#s/' + res.section.id + '/customize';
      render();
    } catch (e) { btn.disabled = false; handleError(e); }
  }

  async function seedSections() {
    try {
      for (const t of window.TEMPLATES) {
        if (S.sections.some((s) => s.template === t.id && !s.archived)) continue;
        const res = await API.call('section.create', window.sectionFromTemplate(t, S.sections));
        res.section.myLevel = 'manager';
        replaceSection(res.section);
      }
      toast('Standard sections created');
      render();
    } catch (e) { handleError(e); }
  }

  async function moveSection(id, dir) {
    const live = liveSections();
    const i = live.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= live.length) return;
    const a = live[i];
    const b = live[j];
    try {
      const ra = await API.call('section.update', { id: a.id, patch: { order: b.order } });
      const rb = await API.call('section.update', { id: b.id, patch: { order: a.order } });
      replaceSection(ra.section);
      replaceSection(rb.section);
      render();
    } catch (e) { handleError(e); }
  }

  async function archiveSection(id, archived) {
    if (archived && S._armSec !== id) { S._armSec = id; render(); return; }
    S._armSec = null;
    try {
      const res = await API.call('section.update', { id, patch: { archived } });
      replaceSection(res.section);
      toast(archived ? 'Section removed. You can restore it below.' : 'Section restored');
      render();
    } catch (e) { handleError(e); }
  }

  // ------------------------------------------------------------ events

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const d = el.dataset;
    switch (d.act) {
      case 'open': openItem(d.id); break;
      case 'new': newItem(d.section); break;
      case 'new-linked': closeDrawer(); newItem(d.section, { [d.field]: d.target }); break;
      case 'close-drawer': closeDrawer(); break;
      case 'item-delete': deleteItem(); break;
      case 'add-comment': addComment(); break;
      case 'upload': { const fi = $('#fileInput'); if (fi) fi.click(); break; }
      case 'file-open': openFile(d.file); break;
      case 'view': S.f.view[d.section] = d.v; saveViews(); render(); break;
      case 'export': exportReport(section(d.section), d.fmt, el); break;
      case 'copy-link': copyLink(S.drawer.id, el); break;
      case 'dash-export': openDashExport(); break;
      case 'arc-open': openArchiveExport(d.id, d.mode); break;
      case 'arc-restore': openArchiveRestore(); break;
      case 'arc-unlock': unlockArchive(); break;
      case 'perf-sort': S.f.perf.sort = d.k; render(); break;
      case 'perf-cal': S.f.cal.who = d.id; location.hash = '#calendar'; break;
      case 'perf-export': {
        exportTables(d.fmt, perfReport(), el.querySelector('b')).then(() => { const m = el.closest('details'); if (m) m.open = false; });
        break;
      }
      case 'search-open': openSearch(); break;
      case 'search-close': closeSearch(); break;
      case 'gs-go': goSearch(Number(d.i)); break;
      case 'full-toggle': toggleFull(el); break;
      // calendar
      case 'cal-view': S.f.cal.view = d.v; render(); break;
      case 'cal-day': S.f.cal.anchor = d.day; S.f.cal.view = 'week'; render(); break;
      case 'cal-nav': {
        const c = S.f.cal;
        const a = parseDay(c.anchor) || new Date();
        if (d.dir === '0') c.anchor = today();
        else if (c.view === 'month') c.anchor = dayStr(new Date(a.getFullYear(), a.getMonth() + Number(d.dir), 1));
        else { a.setDate(a.getDate() + Number(d.dir) * (c.view === 'week' ? 7 : 14)); c.anchor = dayStr(a); }
        render();
        break;
      }
      case 'cal-resync': {
        el.disabled = true;
        el.textContent = 'Syncing…';
        API.call('calendar.resync').then((r) => {
          toast(r.remaining ? `Synced ${r.synced} items. ${r.remaining} left — press again to continue.` : `Google Calendar is up to date (${r.synced} items).`);
        }).catch(handleError).finally(() => { el.disabled = false; el.textContent = 'Re-sync Google Calendar'; });
        break;
      }
      // filter & sort
      case 'fr-toggle': case 'fr-add': case 'fr-del': case 'fr-clear': {
        const sid = $('#secBody').dataset.section;
        const st = fstate(sid);
        if (d.act === 'fr-toggle') {
          if (!st.rules.length) st.open = !st.open;
          if (st.open && !st.rules.length) st.rules.push({ key: 'title', op: 'contains', value: '' });
        }
        if (d.act === 'fr-add') { st.open = true; st.rules.push({ key: 'title', op: 'contains', value: '' }); }
        if (d.act === 'fr-del') { st.rules.splice(Number(d.i), 1); if (!st.rules.length) st.open = false; }
        if (d.act === 'fr-clear') { st.rules = []; st.open = false; }
        saveF();
        refreshSection(true);
        if (d.act !== 'fr-del' && d.act !== 'fr-clear') {
          const inputs = document.querySelectorAll('#filterPanel [data-p="value"]');
          if (inputs.length) inputs[inputs.length - 1].focus();
        }
        break;
      }
      case 'sort-dir': {
        const st = fstate(d.section).sort;
        st.dir = st.dir === 'desc' ? 'asc' : 'desc';
        saveF();
        render();
        break;
      }
      case 'sort-col': {
        const st = fstate(d.section).sort;
        if (st.key === d.key) st.dir = st.dir === 'desc' ? 'asc' : 'desc'; else { st.key = d.key; st.dir = 'asc'; }
        saveF();
        render();
        break;
      }
      case 'src-add': { const dr = srcSync(); dr.suppliers.push({}); render(); break; }
      case 'src-del': { const dr = srcSync(); dr.suppliers.splice(Number(d.i), 1); render(); break; }
      case 'src-save': srcSubmit('sourcing.save'); break;
      case 'src-prepare': srcPrepare(d.id); break;
      case 'src-send': srcSend(d.id); break;
      case 'src-test': srcTest(d.id); break;
      case 'src-check': srcCheckReplies(); break;
      case 'quote-save': quoteSave(d.id, false); break;
      case 'quote-confirm': quoteSave(d.id, true); break;
      case 'quote-download': quoteDownload(d.id); break;
      case 'src-import': srcImport(d.id, d.section); break;
      case 'src-refresh': srcRefresh(d.id); break;
      case 'src-remove': srcRemove(d.id); break;
      case 'src-hub-load': srcState.hub = null; render(); break;
      case 'src-approve': srcSubmit('sourcing.approve'); break;
      case 'refresh': loadData().then(() => toast('Up to date')); break;
      case 'signout': signOut(); break;
      case 'demo-login':
        try { API.login(d.id); loadData(); } catch (err) { showLogin(err.message); }
        break;
      case 'reset-demo': API.reset(); showLogin(); toast('Example data restored'); break;
      case 'seed-sections': seedSections(); break;
      case 'sec-new': openNewSection(); break;
      case 'sec-move': moveSection(d.id, Number(d.dir)); break;
      case 'sec-archive': archiveSection(d.id, true); break;
      case 'sec-restore': archiveSection(d.id, false); break;
      case 'user-new': openUser(null); break;
      case 'user-edit': openUser(d.id); break;
      case 'user-delete':
        if (!S.drawer.armed) { openUser(S.drawer.id, true); break; }
        API.call('user.remove', { id: S.drawer.id }).then(() => {
          const gone = S.drawer.id;
          S.users = S.users.filter((u) => u.id !== gone);
          S.access = S.access.filter((a) => a.userId !== gone);
          closeDrawer();
          toast('User deleted');
          render();
        }).catch(handleError);
        break;
      // customize columns
      case 'tpl-cancel': S.tpl = null; break;
      case 'tpl-save': saveTemplate(); break;
      case 'tpl-add': {
        S.tpl.fields.push({ key: 'f' + uid(), label: 'New column', type: 'text', onCard: false });
        rerenderTpl();
        const inputs = document.querySelectorAll('[data-tf][data-prop="label"]');
        if (inputs.length) { inputs[inputs.length - 1].focus(); inputs[inputs.length - 1].select(); }
        break;
      }
      case 'tpl-move': {
        const i = Number(d.i);
        const j = i + Number(d.dir);
        const fs = S.tpl.fields;
        if (j < 0 || j >= fs.length) break;
        [fs[i], fs[j]] = [fs[j], fs[i]];
        rerenderTpl();
        break;
      }
      case 'tpl-del': {
        const f = S.tpl.fields[Number(d.i)];
        if (S.tpl.armed !== f.key) { S.tpl.armed = f.key; rerenderTpl(); break; }
        S.tpl.fields.splice(Number(d.i), 1);
        if (S.tpl.stageField === f.key) S.tpl.stageField = '';
        S.tpl.armed = null;
        rerenderTpl();
        break;
      }
      case 'opt-add': {
        const f = S.tpl.fields[Number(d.i)];
        f.options = f.options || [];
        f.options.push({ value: 'o' + uid(), label: 'New option', color: 'gray' });
        rerenderTpl();
        break;
      }
      case 'opt-del': S.tpl.fields[Number(d.i)].options.splice(Number(d.j), 1); rerenderTpl(); break;
      case 'opt-move': {
        const os = S.tpl.fields[Number(d.i)].options;
        const j = Number(d.j);
        const k = j + Number(d.dir);
        if (k < 0 || k >= os.length) break;
        [os[j], os[k]] = [os[k], os[j]];
        rerenderTpl();
        break;
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    const g = $('#gsearch');
    const searching = g && !g.hidden;
    if (searching) {
      const n = (S.gs && S.gs.list.length) || 0;
      if (e.key === 'Escape') { e.preventDefault(); closeSearch(); return; }
      if (e.key === 'ArrowDown' && n) { e.preventDefault(); S.gs.sel = (S.gs.sel + 1) % n; markSel(); return; }
      if (e.key === 'ArrowUp' && n) { e.preventDefault(); S.gs.sel = (S.gs.sel - 1 + n) % n; markSel(); return; }
      if (e.key === 'Enter' && e.target.id === 'gsInput') { e.preventDefault(); goSearch(S.gs ? S.gs.sel : 0); return; }
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    // Ctrl/Cmd + K (either case, so Caps Lock does not break it) or "/" opens search
    if (S.loaded && ((String(e.key).toLowerCase() === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing))) { e.preventDefault(); openSearch(); return; }
    if (e.key === 'Escape' && S.drawer) closeDrawer();
    if (e.key === 'Enter' && e.target.matches('.card[data-act="open"]')) openItem(e.target.dataset.id);
  });

  document.addEventListener('submit', (e) => {
    // getAttribute, not .id: a field named "id" or "email" would shadow the form's own properties
    const id = e.target.getAttribute('id');
    if (id === 'mailSettings') { e.preventDefault(); saveMailSettings(e.target); return; }
    if (!['itemForm', 'userForm', 'sectionForm', 'dashExportForm', 'archiveForm', 'restoreForm'].includes(id)) return;
    e.preventDefault();
    if (id === 'archiveForm') runArchiveExport(e.target);
    if (id === 'restoreForm') { if (S.drawer.payload) runRestore(e.target); else if (S.drawer.box) unlockArchive(); }
    if (id === 'itemForm') saveItem(e.target);
    if (id === 'userForm') saveUser(e.target);
    if (id === 'sectionForm') createSection(e.target);
    if (id === 'dashExportForm') runDashExport(e.target);
  });

  function tplInput(t) {
    if (!S.tpl) return false;
    if (t.dataset.tpl) { S.tpl[t.dataset.tpl] = t.value; return t.dataset.tpl === 'stageField'; }
    if (t.dataset.tf !== undefined) {
      const f = S.tpl.fields[Number(t.dataset.tf)];
      const prop = t.dataset.prop;
      if (t.type === 'checkbox') { if (t.checked) f[prop] = true; else delete f[prop]; return false; }
      f[prop] = t.value;
      if (prop === 'type') {
        if (f.type === 'select' && !(f.options || []).length) f.options = [{ value: 'o' + uid(), label: 'Option 1', color: 'gray' }];
        if (!['date', 'datetime'].includes(f.type)) delete f.due;
        if (!['currency', 'number'].includes(f.type)) delete f.total;
        if (f.type !== 'select' && S.tpl.stageField === f.key) S.tpl.stageField = '';
        return true;
      }
      return false;
    }
    if (t.dataset.to !== undefined) {
      const [i, j] = t.dataset.to.split('.').map(Number);
      const o = S.tpl.fields[i].options[j];
      const prop = t.dataset.prop;
      if (prop === 'done' || prop === 'met') { if (t.checked) o[prop] = true; else delete o[prop]; return false; }
      if (prop === 'alertDays') { const n = Number(t.value); if (n > 0) o.alertDays = n; else delete o.alertDays; return false; }
      o[prop] = t.value;
      return prop === 'color';
    }
    return false;
  }

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'srcSection') { srcState.sectionId = t.value; srcState.stage = ''; render(); return; }
    if (t.id === 'srcStage') { srcState.stage = t.value; render(); return; }
    if (t.id === 'srcSkipAsana') { srcState.skipAsana = t.checked ? route().id : ''; render(); return; }
    if (t.id === 'srcRegister') {
      const pick = registerSuppliers().find((x) => x.id === t.value);
      const dr = srcSync();
      if (pick && dr) { dr.suppliers.push({ company: pick.company, email: pick.email, type: pick.type, country: pick.country, source: pick.source, note: '' }); render(); }
      return;
    }
    if (t.id === 'fileInput' && t.files && t.files[0]) { uploadFile(t.files[0]); return; }
    if (t.id === 'arcFile' && t.files && t.files[0]) { readArchiveFile(t.files[0]); return; }
    if (t.dataset.access) {
      const [sid, uid2] = t.dataset.access.split('|');
      t.className = 'lvl lvl-' + t.value;
      setAccess(sid, uid2, t.value).catch((err) => { handleError(err); render(); });
      return;
    }
    if (t.dataset.perf) {
      S.f.perf[t.dataset.perf] = t.value;
      render();
      return;
    }
    if (t.dataset.cal) {
      S.f.cal[t.dataset.cal] = t.value;
      render();
      return;
    }
    if (t.dataset.sort) {
      fstate(t.dataset.sort).sort.key = t.value;
      saveF();
      render();
      return;
    }
    if (t.dataset.fr !== undefined) {
      const sid = $('#secBody').dataset.section;
      const s = section(sid);
      const r = fstate(sid).rules[Number(t.dataset.fr)];
      if (t.dataset.p === 'key') {
        r.key = t.value;
        r.op = OPS[opGroup(colOf(s, r.key).type)][0][0];
        r.value = '';
      } else if (t.dataset.p === 'op') {
        r.op = t.value;
        if (NO_VALUE.includes(r.op)) r.value = '';
      } else {
        r.value = t.value;
      }
      saveF();
      refreshSection(t.dataset.p !== 'value');
      return;
    }
    if (t.dataset.filter) {
      S.f[t.dataset.filter] = t.value;
      const body = $('#secBody');
      if (body) body.innerHTML = sectionBody(section(body.dataset.section)); else render();
      return;
    }
    if (tplInput(t)) rerenderTpl();
  });

  let searchTimer;
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.closest('#srcForm')) { srcSync(); return; }
    if (t.matches('[data-pick-filter]')) {
      const q = t.value.toLowerCase();
      t.closest('.pick-b').querySelectorAll('.prow').forEach((r) => { r.hidden = q && !r.textContent.toLowerCase().includes(q); });
      return;
    }
    if (t.id === 'gsInput') { renderSearch(); return; }
    if (t.dataset.fr !== undefined && t.dataset.p === 'value' && t.tagName === 'INPUT' && t.type !== 'date') {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        fstate($('#secBody').dataset.section).rules[Number(t.dataset.fr)].value = t.value;
        saveF();
        refreshSection(false);
      }, 200);
      return;
    }
    if (t.dataset.filterInput) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        S.f[t.dataset.filterInput] = t.value;
        const body = $('#secBody');
        if (body) body.innerHTML = sectionBody(section(body.dataset.section));
      }, 150);
      return;
    }
    if (t.type !== 'checkbox' && t.tagName !== 'SELECT') tplInput(t);
  });

  // Drag and drop between board columns
  let dragId = null;
  document.addEventListener('dragstart', (e) => {
    const c = e.target.closest && e.target.closest('[data-drag]');
    if (!c) return;
    dragId = c.dataset.drag;
    e.dataTransfer.setData('text/plain', dragId);
    e.dataTransfer.effectAllowed = 'move';
    c.classList.add('dragging');
  });
  document.addEventListener('dragend', (e) => {
    const c = e.target.closest && e.target.closest('[data-drag]');
    if (c) c.classList.remove('dragging');
    document.querySelectorAll('.drop-on').forEach((x) => x.classList.remove('drop-on'));
    dragId = null;
  });
  document.addEventListener('dragover', (e) => {
    const col = e.target.closest && e.target.closest('[data-drop-section]');
    if (!col || !dragId) return;
    e.preventDefault();
    if (!col.classList.contains('drop-on')) {
      document.querySelectorAll('.drop-on').forEach((x) => x.classList.remove('drop-on'));
      col.classList.add('drop-on');
    }
  });
  document.addEventListener('drop', (e) => {
    const col = e.target.closest && e.target.closest('[data-drop-section]');
    if (!col) return;
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || dragId;
    col.classList.remove('drop-on');
    const it = id && item(id);
    if (it && it.sectionId === col.dataset.dropSection) moveItem(id, col.dataset.dropStage);
  });

  window.addEventListener('hashchange', () => {
    closeDrawer();
    const r = route();
    if (!(r.view === 's' && r.sub === 'customize')) S.tpl = null;
    S.f.q = '';
    render();
  });

  // Pick up teammates' changes every 90 s while the tab is visible and nothing is being edited
  setInterval(() => {
    if (API.mode === 'remote' && S.loaded && !S.drawer && !S.tpl && !dragId && document.visibilityState === 'visible') loadData(true);
  }, 90000);

  boot();
})();
