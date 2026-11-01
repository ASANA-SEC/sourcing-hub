// Data layer. Both backends answer the same actions through call(action, payload):
//   Remote — Google Apps Script web app (Sheets + Drive), used when API_URL is set
//   Demo   — this browser's localStorage with example data; runs the same rules (core.js)
(function () {
  'use strict';
  const CFG = window.APP_CONFIG || {};
  const DEMO_KEY = 'sourcinghub_demo_v1';
  const DEMO_USER = 'sourcinghub_demo_user';
  const DEMO_FROM = 'buyer@example.com';
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* blocked */ } }

  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error('Could not read the file.'));
      r.readAsDataURL(file);
    });
  }

  // ------------------------------------------------------------ Remote

  const Remote = {
    mode: 'remote',
    token: null,

    async call(action, payload) {
      let res;
      try {
        res = await fetch(CFG.API_URL, {
          method: 'POST',
          // text/plain keeps this a "simple" request, so Apps Script needs no CORS preflight
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action, token: this.token, payload: payload || {} }),
        });
      } catch (e) {
        throw Object.assign(new Error('Cannot reach the server. Check your internet connection.'), { code: 'NETWORK' });
      }
      let out;
      try { out = await res.json(); } catch (e) {
        throw Object.assign(new Error('The server sent an unexpected reply. Check API_URL in config.js.'), { code: 'BAD_REPLY' });
      }
      if (!out.ok) throw Object.assign(new Error(out.error || 'Request failed'), { code: out.code });
      return out.data;
    },

    // Read only: the same Google login is sent to RFQ Hub, which applies that person's own access there.
    async hubCall(action, payload) {
      if (action !== 'bootstrap' && action !== 'item.file') throw new Error('RFQ Hub is read only here.');
      let res;
      try {
        res = await fetch(CFG.RFQ_HUB_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action, token: this.token, payload: payload || {} }),
        });
        const out = await res.json();
        if (!out.ok) throw Object.assign(new Error(out.error || 'RFQ Hub refused the request.'), { code: out.code });
        return out.data;
      } catch (e) {
        if (e.code) throw e;
        throw new Error('Cannot reach RFQ Hub. Check your internet connection.');
      }
    },

    async upload(id, file) {
      return this.call('item.upload', { id, fileName: file.name, mimeType: file.type, base64: await readBase64(file) });
    },
  };

  // ------------------------------------------------------------ Demo

  function day(offset) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  const stamp = (offsetDays) => new Date(Date.now() + offsetDays * 864e5).toISOString();

  const DEMO_ACCOUNTS = {
    'sam.secov@gmail.com': 'Super admin — everything, including accounts, access and sections',
    'szesian.mitosc@gmail.com': 'Super admin',
    'eileen.secov@gmail.com': 'Super admin',
    'siti@example.com': 'Supplier Register: Manager — can approve supplier lists',
    'mei@example.com': 'Supplier Register: Viewer — can look, cannot change',
    'raj@example.com': 'No access',
  };

  function seed() {
    const SAM = 'sam.secov@gmail.com';
    const users = [
      ['sam.secov@gmail.com', 'Sam'], ['szesian.mitosc@gmail.com', 'Sze Sian'], ['eileen.secov@gmail.com', 'Eileen'],
      ['siti@example.com', 'Siti (Buyer)'], ['mei@example.com', 'Mei Ling (Estimator)'], ['raj@example.com', 'Raj (Doc Control)'],
    ].map(([id, name]) => ({ id, name, active: true, createdBy: SAM, createdAt: stamp(-60), updatedAt: stamp(-60) }));
    const sections = window.TEMPLATES.map((t, i) => ({ id: 's_sups', name: t.name, template: t.id, order: i + 1, fields: clone(t.fields), stageField: t.stageField, archived: false, createdBy: SAM, createdAt: stamp(-60), updatedAt: stamp(-60) }));
    const access = [['siti@example.com', 'manager'], ['mei@example.com', 'viewer']]
      .map(([userId, level], i) => ({ id: 'a' + i, sectionId: 's_sups', userId, level, createdBy: SAM, createdAt: stamp(-60), updatedAt: stamp(-60) }));
    const T = 'siti@example.com';
    const pad = (n) => String(n).padStart(3, '0');
    const sup = (n, title, category, contact, email, type, country, status, rating, brands, expiry) => ({
      id: 'i_sp' + n, sectionId: 's_sups', title,
      data: { supplierCode: 'SUP-' + pad(n), category, contact, email, phone: '', supplierType: type, country, status, rating, brands, expiryDate: expiry === null ? '' : day(expiry), website: '', notes: '' },
      editors: [T], collaborators: [], files: [], stageChangedAt: stamp(-90), createdBy: SAM, createdAt: stamp(-92), updatedAt: stamp(-90),
    });
    const items = [
      sup(1, 'Supplier A Valves (example)', 'valves', 'Mr Tan', 'sales@supplier-a.example.com', 'Distributor', 'Malaysia', 'approved', 'a', 'Ball, gate & globe valves', 200),
      sup(2, 'Supplier C Electrical (example)', 'electrical', 'Ms Nurul', 'quotes@supplier-c.example.com', 'Stockist', 'Singapore', 'approved', 'a', 'Lamps, ballasts, cable glands', 300),
      sup(3, 'Supplier D HVAC (example)', 'mechanical', 'Mr Kumar', '', 'Agent', 'Malaysia', 'evaluation', '', 'AHU, chillers', null),
      sup(4, 'Supplier F Trading (example)', 'valves', 'Mr Lim', 'lim@supplier-f.example.com', 'Supplier', 'Malaysia', 'blacklisted', 'c', 'Late deliveries 2025', null),
    ];
    return { users, sections, access, items, comments: [], sourcing: [], emails: [], quotes: [],
      settings: [{ id: 'email', fromEmail: DEMO_FROM, cc: 'colleague.one@example.com; colleague.two@example.com', signature: 'Example Buyer\n\nEXAMPLE COMPANY SDN BHD\nKuala Lumpur, Malaysia', updatedBy: SAM, updatedAt: stamp(-1), notifyEmail: SAM, followUpOn: false, volumetricDivisor: 5000, freightRates: 'Singapore, Labuan, 12', rates: { USD: { rate: 4.056, date: day(-1) }, SGD: { rate: 3.1, date: day(-1) } } }] };
  }

  /** What RFQ Hub would answer in demo mode: one RFQ section with a Pending column. */
  function demoHub() {
    const o = (value, label, color) => ({ value, label, color });
    const section = {
      id: 'hub_rfq', name: 'RFQ NOV 2026 (example)', template: 'rfqs', stageField: 'stage',
      fields: [{ key: 'title', label: 'Title', type: 'text' }, { key: 'stage', label: 'Stage', type: 'select', options: [o('todo', 'To Do', 'gray'), o('pending', 'Pending', 'teal'), o('complete', 'Complete', 'amber')] }, { key: 'closingDate', label: 'Closing date & time', type: 'datetime', due: true }, { key: 'notes', label: 'Notes', type: 'longtext' }],
    };
    const task = (id, title, stage, closing, notes, files) => ({ id, sectionId: 'hub_rfq', title, data: { rfqNo: 'RFQ-DEMO-' + id.slice(-3), client: 'Client (example)', stage, closingDate: day(closing) + 'T17:00', notes }, files: files || [], updatedAt: stamp(-1) });
    return {
      sections: [section],
      items: [
        task('hub_101', 'Supply of UV lamps and ballasts for example plant', 'pending', 7, 'DUE: example client deadline\n\n1. LAMP, UV, EXAMPLE MODEL\nPOWER RATING: 39 W\nQTY: 4 PC\n\n2. BALLAST, ELECTRONIC, EXAMPLE MODEL\nVOLTAGE RATING: 220-240 VAC\nQTY: 2 EA', [{ id: 'f1', name: 'example-specification.pdf', mimeType: 'application/pdf', size: 1024 }]),
        task('hub_102', 'Supply of instrument tubing and fittings', 'pending', 3, '1. TUBING, EXAMPLE 316SS\nQTY: 100 M\n\nAttachments in Asana (not copied): example-drawing.pdf, example-datasheet.pdf'),
        task('hub_103', 'Supply of cable glands', 'todo', 9, '1. CABLE GLAND, EXAMPLE\nQTY: 20 EA'),
      ],
    };
  }

  function demoJson(key) { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; } }
  function demoLog(key, row) { let list = []; try { list = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { list = []; } list.push(row); localStorage.setItem(key, JSON.stringify(list)); }

  function demoStore() {
    let db = null;
    function load() {
      if (db) return db;
      try { db = JSON.parse(localStorage.getItem(DEMO_KEY) || 'null'); } catch (e) { db = null; }
      if (!db || !Array.isArray(db.sections)) db = seed();
      ['users', 'sections', 'access', 'items', 'comments', 'sourcing', 'emails', 'settings', 'quotes'].forEach((t) => { if (!Array.isArray(db[t])) db[t] = []; });
      persist();
      return db;
    }
    function persist() { try { localStorage.setItem(DEMO_KEY, JSON.stringify(db)); } catch (e) { /* blocked */ } }
    const noDrive = () => Core.fail('DEMO', 'Attachments are saved to Google Drive. They start working after the Google setup in README.md.');
    return {
      all: (t) => clone(load()[t]),
      insert: (t, rec) => { load()[t].push(clone(rec)); persist(); },
      insertMany: (t, recs) => { load()[t].push(...clone(recs)); persist(); },
      save: (t, rec) => {
        const rows = load()[t];
        const i = rows.findIndex((r) => r.id === rec.id);
        if (i < 0) throw Core.fail('NOT_FOUND', 'This record no longer exists.');
        rows[i] = clone(rec);
        persist();
      },
      del: (t, id) => { db[t] = load()[t].filter((r) => r.id !== id); persist(); },
      delWhere: (t, fn) => { db[t] = load()[t].filter((r) => !fn(r)); persist(); },
      now: () => new Date().toISOString(),
      kl: (iso) => {
        const fake = !iso && demoJson('sourcinghub_demo_kl');
        if (fake && fake.date) return fake;
        const d = new Date(iso || Date.now());
        const shifted = new Date(d.getTime() + 8 * 36e5);
        return { date: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours() };
      },
      uid: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      saveFile: (item, name) => { if (item.sectionId === 'sourcing') return { id: 'demo_' + name, name, mimeType: 'application/pdf', size: 1 }; throw noDrive(); },
      readFile: () => { throw noDrive(); },
      // Example answer per supplier: set sourcinghub_demo_ai to test the comparison.
      ai: {
        ready: () => !localStorage.getItem('sourcinghub_demo_nokey'),
        extract() { const list = demoJson('sourcinghub_demo_ai'); const next = (list.queue || []).shift(); localStorage.setItem('sourcinghub_demo_ai', JSON.stringify(list)); if (!next) throw new Error('No demo answer'); return next; },
      },
      // Nothing leaves the browser in demo mode.
      mail: {
        quota: 100,
        status() { return { account: DEMO_FROM, remaining: this.quota }; },
        createDraft: () => ({ draftId: 'demo_draft', messageId: 'demo_msg' }),
        deleteDraft: () => {},
        sendDraft(id) { if (localStorage.getItem('sourcinghub_demo_fail')) throw new Error('Service invoked too many times for one day: email.'); this.quota -= 3; return { messageId: 'demo_' + Date.now(), threadId: 'demo_thread_' + id + '_' + Math.random().toString(36).slice(2, 8) }; },
        sendTest() { this.quota -= 1; },
        threadMessages(threadId) { return demoJson('sourcinghub_demo_replies')[threadId] || []; },
        threadFiles() { return { files: [{ name: 'Quote.pdf', kind: 'pdf' }], skipped: [], text: 'Please see attached.' }; },
        replyAll(threadId, body) { demoLog('sourcinghub_demo_outbox', { threadId, body }); this.quota -= 2; },
        notify(to, subject) { demoLog('sourcinghub_demo_alerts', { to, subject }); this.quota -= 1; },
      },
      reset: () => { try { localStorage.removeItem(DEMO_KEY); } catch (e) { /* blocked */ } db = null; },
    };
  }

  const store = demoStore();

  const Demo = {
    mode: 'demo',
    me: null,

    restore() {
      const email = ssGet(DEMO_USER);
      if (!email) return false;
      try { this.me = Core.identify(store, email, ''); } catch (e) { this.me = null; ssSet(DEMO_USER, null); }
      return !!this.me;
    },
    login(email) {
      this.me = Core.identify(store, email, '');
      ssSet(DEMO_USER, email);
    },
    logout() { this.me = null; ssSet(DEMO_USER, null); },
    accounts() {
      return store.all('users').filter((u) => u.active !== false)
        .map((u) => ({ id: u.id, name: u.name, note: DEMO_ACCOUNTS[u.id] || 'Added in this demo' }));
    },
    async call(action, payload) {
      if (!this.me) throw Core.fail('AUTH_REQUIRED', 'Please sign in.');
      // Re-check the account each call, like the server does
      this.me = Core.identify(store, this.me.id, '');
      return clone(Core.handle(store, this.me, action, payload || {}));
    },
    async hubCall(action) { return action === 'item.file' ? { name: 'example', mimeType: 'application/pdf', base64: 'QQ==' } : clone(demoHub()); },
    async upload(id, file) {
      return this.call('item.upload', { id, fileName: file.name, mimeType: file.type, base64: '' });
    },
    reset() { store.reset(); this.logout(); },
  };

  // On this computer, http://localhost:8765/?demo forces demo mode for testing.
  // &reset starts from fresh example data; &as=<email> signs in as that example account (used to record the user guide).
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const params = new URLSearchParams(location.search);
  const forceDemo = local && params.has('demo');
  if (forceDemo && params.has('reset')) store.reset();
  if (forceDemo && params.get('as')) { try { Demo.login(params.get('as')); } catch (e) { /* unknown example account */ } }
  Demo.clean = forceDemo && params.has('clean'); // hide the demo banner for user-guide screenshots
  window.API = CFG.API_URL && !forceDemo ? Remote : Demo;
})();
