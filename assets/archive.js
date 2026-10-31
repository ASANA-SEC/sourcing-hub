// Sourcing Hub section archives.
// An archive is ONE self-contained HTML file: open it in any browser (offline) to view the section,
// or upload it under Manage sections > Restore from archive to bring the section back.
// The data sits in <script type="application/json" id="ph-archive">, optionally encrypted
// (PBKDF2-SHA256 + AES-256-GCM, Web Crypto), so the same file serves the viewer and the restore.
(function () {
  'use strict';

  const FORMAT = 'project-hub-archive';
  const VERSION = 1;
  const ITERATIONS = 310000;

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const b64 = (buf) => { let s = ''; new Uint8Array(buf).forEach((c) => { s += String.fromCharCode(c); }); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function keyFor(password, salt) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function seal(payload, password) {
    const meta = {
      section: payload.section.name, items: payload.items.length, comments: payload.comments.length,
      exportedAt: payload.exportedAt, exportedBy: payload.exportedByName,
    };
    if (!password) return { format: FORMAT, version: VERSION, encrypted: false, meta, payload };
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await keyFor(password, salt);
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload)));
    return { format: FORMAT, version: VERSION, encrypted: true, meta, kdf: { iterations: ITERATIONS, salt: b64(salt) }, iv: b64(iv), data: b64(data) };
  }

  async function open(box, password) {
    if (!box.encrypted) return box.payload;
    try {
      const key = await keyFor(password || '', unb64(box.kdf.salt));
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.data));
      return JSON.parse(dec.decode(plain));
    } catch (e) {
      throw new Error('Wrong password, or the file has been changed.');
    }
  }

  /** Read an archive file's text; returns the sealed box (check box.encrypted before opening). */
  function read(text) {
    const m = /<script type="application\/json" id="ph-archive">([\s\S]*?)<\/script>/.exec(text);
    if (!m) throw new Error('This is not a Sourcing Hub archive file.');
    let box;
    try { box = JSON.parse(m[1]); } catch (e) { throw new Error('The archive file is damaged.'); }
    if (box.format !== FORMAT) throw new Error('This is not a Sourcing Hub archive file.');
    if (box.version > VERSION) throw new Error('This archive was made by a newer version of Sourcing Hub.');
    return box;
  }

  async function build(payload, password) {
    const box = await seal(payload, password);
    const json = JSON.stringify(box).replace(/</g, '\\u003c');
    const title = 'Archive · ' + payload.section.name;
    return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + escapeHtml(title) + '</title><meta name="generator" content="Sourcing Hub archive v' + VERSION + '">' +
      '<style>' + VIEWER_CSS + '</style></head><body><div id="app"><p class="boot">Opening archive…</p></div>' +
      '<script type="application/json" id="ph-archive">' + json + '</script>' +
      '<script>(' + viewer.toString() + ')();</script></body></html>';
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ------------------------------------------------------------------ the offline viewer
  // Runs inside the archive file on its own: no network, no Sourcing Hub code.

  function viewer() {
    'use strict';
    var box = JSON.parse(document.getElementById('ph-archive').textContent);
    var root = document.getElementById('app');
    var P = null;
    var state = { q: '', stage: 'all', open: null };
    var esc = function (v) { return String(v === null || v === undefined ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
    var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function dt(v, withTime) {
      if (!v) return '';
      var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(v);
      if (!m) return v;
      var d = /Z$|[+-]\d\d:\d\d$/.test(v) ? new Date(v) : new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
      var s = d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear();
      if ((withTime || m[4]) && (d.getHours() || d.getMinutes())) s += ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      return s;
    }
    var money = function (n) { return 'RM ' + Number(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    function person(id) { var u = (P.users || []).filter(function (x) { return x.id === id; })[0]; return (u && u.name) || id || ''; }
    function opt(f, v) { return (f.options || []).filter(function (o) { return o.value === v; })[0]; }
    function val(it, f) { return f.key === 'title' ? it.title : (it.data || {})[f.key]; }
    function text(it, f) {
      var v = val(it, f);
      if (v === '' || v === null || v === undefined || v === false) return '';
      switch (f.type) {
        case 'currency': return money(v);
        case 'percent': return v + '%';
        case 'date': case 'datetime': return dt(v);
        case 'select': var o = opt(f, v); return o ? o.label : v;
        case 'person': return person(v);
        case 'checkbox': return 'Yes';
        case 'link':
          var t = (P.items || []).filter(function (x) { return x.id === v; })[0] || (P.linked || {})[v];
          return t ? t.title : '(item in another section)';
        default: return String(v);
      }
    }
    function chipFor(it) {
      var sf = P.section.stageField && P.section.fields.filter(function (f) { return f.key === P.section.stageField; })[0];
      var o = sf && opt(sf, val(it, sf));
      return o ? '<span class="chip c-' + esc(o.color) + '">' + esc(o.label) + '</span>' : '';
    }

    function askPassword(err) {
      root.innerHTML = '<div class="lock"><form id="pw"><div class="mark">SH</div><h1>' + esc(box.meta.section) + '</h1>' +
        '<p>Sourcing Hub archive · ' + esc(box.meta.items) + ' items · exported ' + esc(dt(box.meta.exportedAt, true)) + '</p>' +
        '<label>This archive is protected. Enter its password.<input type="password" id="pwd" autocomplete="current-password" autofocus></label>' +
        (err ? '<div class="err">' + esc(err) + '</div>' : '') + '<button type="submit">Open archive</button></form></div>';
      document.getElementById('pw').addEventListener('submit', function (e) {
        e.preventDefault();
        var pw = document.getElementById('pwd').value;
        e.target.querySelector('button').textContent = 'Opening…';
        unlock(pw).then(function (p) { P = p; render(); }, function () { askPassword('Wrong password. Try again.'); });
      });
    }
    function unlock(password) {
      var u = function (s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); };
      return crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
        .then(function (base) { return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: u(box.kdf.salt), iterations: box.kdf.iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']); })
        .then(function (key) { return crypto.subtle.decrypt({ name: 'AES-GCM', iv: u(box.iv) }, key, u(box.data)); })
        .then(function (plain) { return JSON.parse(new TextDecoder().decode(plain)); });
    }

    function filtered() {
      var q = state.q.toLowerCase();
      var sf = P.section.stageField;
      return P.items.filter(function (it) {
        if (state.stage !== 'all' && (it.data || {})[sf] !== state.stage) return false;
        if (!q) return true;
        var hay = P.section.fields.map(function (f) { return text(it, f); }).join(' ') + ' ' + (it.editors || []).map(person).join(' ');
        return hay.toLowerCase().indexOf(q) >= 0;
      });
    }

    function render() {
      var s = P.section;
      var cols = s.fields.filter(function (f) { return f.type !== 'longtext'; });
      var sf = s.stageField && s.fields.filter(function (f) { return f.key === s.stageField; })[0];
      var list = filtered();
      var totals = s.fields.filter(function (f) { return f.total; });
      document.title = 'Archive · ' + s.name;
      root.innerHTML =
        '<header class="top"><div class="mark">SH</div><div><div class="kick">Sourcing Hub archive · read only</div><h1>' + esc(s.name) + '</h1>' +
        '<p>' + P.items.length + ' items · ' + P.comments.length + ' comments · exported ' + esc(dt(P.exportedAt, true)) + ' by ' + esc(P.exportedByName) + '</p></div></header>' +
        '<main>' +
        (sf ? '<div class="stages">' + sf.options.map(function (o) {
          var n = P.items.filter(function (it) { return (it.data || {})[sf.key] === o.value; }).length;
          return n ? '<button type="button" class="st' + (state.stage === o.value ? ' on' : '') + '" data-stage="' + esc(o.value) + '"><i class="f-' + esc(o.color) + '"></i>' + esc(o.label) + ' <b>' + n + '</b></button>' : '';
        }).join('') + (state.stage !== 'all' ? '<button type="button" class="st" data-stage="all">Show all</button>' : '') + '</div>' : '') +
        '<div class="bar"><input type="search" id="q" placeholder="Search this archive" value="' + esc(state.q) + '">' +
        '<button type="button" id="csv">Download CSV</button><button type="button" id="print">Print</button></div>' +
        '<p class="count">' + list.length + ' shown' + totals.map(function (f) { return ' · ' + esc(f.label) + ' ' + money(list.reduce(function (t, it) { return t + (Number(val(it, f)) || 0); }, 0)); }).join('') + '</p>' +
        '<div class="tw"><table><thead><tr>' + cols.map(function (f) { return '<th>' + esc(f.label) + '</th>'; }).join('') + '<th>Editors</th></tr></thead><tbody>' +
        (list.map(function (it) {
          return '<tr data-id="' + esc(it.id) + '" tabindex="0">' + cols.map(function (f) {
            return '<td class="' + (f.key === 'title' ? 'tt' : ['currency', 'number'].indexOf(f.type) >= 0 ? 'r' : '') + '">' + (f.key === s.stageField ? chipFor(it) : esc(text(it, f))) + '</td>';
          }).join('') + '<td>' + esc((it.editors || []).map(person).join(', ')) + '</td></tr>';
        }).join('') || '<tr><td colspan="' + (cols.length + 1) + '" class="none">Nothing matches.</td></tr>') +
        '</tbody></table></div>' +
        '<p class="foot">To bring this section back, a super admin opens Sourcing Hub, goes to Manage sections and chooses Restore from archive.</p></main>' +
        (state.open ? detail(state.open) : '');
      wire();
    }

    function detail(id) {
      var it = P.items.filter(function (x) { return x.id === id; })[0];
      if (!it) return '';
      var s = P.section;
      var thread = P.comments.filter(function (c) { return c.itemId === id; }).sort(function (a, b) { return (a.createdAt || '').localeCompare(b.createdAt || ''); });
      return '<div class="scrim" data-close="1"></div><aside class="pane"><button type="button" class="x" data-close="1" aria-label="Close">×</button>' +
        '<div class="kick">' + esc(s.name) + '</div><h2>' + esc(it.title) + '</h2>' + chipFor(it) +
        '<dl>' + s.fields.filter(function (f) { return f.key !== 'title'; }).map(function (f) {
          var t = text(it, f);
          return '<dt>' + esc(f.label) + '</dt><dd' + (f.type === 'longtext' ? ' class="long"' : '') + '>' + (t ? esc(t) : '<span class="muted">—</span>') + '</dd>';
        }).join('') +
        '<dt>Editors</dt><dd>' + (esc((it.editors || []).map(person).join(', ')) || '<span class="muted">—</span>') + '</dd>' +
        '<dt>Collaborators</dt><dd>' + (esc((it.collaborators || []).map(person).join(', ')) || '<span class="muted">—</span>') + '</dd>' +
        '<dt>Created</dt><dd>' + esc(dt(it.createdAt, true)) + (it.createdBy ? ' by ' + esc(person(it.createdBy)) : '') + '</dd>' +
        '<dt>Last updated</dt><dd>' + esc(dt(it.updatedAt, true)) + '</dd></dl>' +
        '<h3>Attachments</h3>' + ((it.files || []).length ? '<ul class="files">' + it.files.map(function (f) {
          return '<li>' + esc(f.name) + ' <small>' + (f.size ? Math.max(1, Math.round(f.size / 1024)) + ' KB · ' : '') + esc(person(f.uploadedBy)) + '</small>' +
            (f.id ? ' <a href="https://drive.google.com/file/d/' + encodeURIComponent(f.id) + '/view" target="_blank" rel="noopener">Open in Google Drive</a>' : '') + '</li>';
        }).join('') + '</ul><p class="muted small">Files stay in the company Google Drive; opening them needs access to it.</p>' : '<p class="muted">None.</p>') +
        '<h3>Comments &amp; activity</h3>' + (thread.length ? thread.map(function (c) {
          return '<div class="msg' + (c.kind === 'log' ? ' log' : '') + '"><b>' + esc(person(c.author)) + '</b> <small>' + esc(dt(c.createdAt, true)) + '</small><div>' + esc(c.text) + '</div></div>';
        }).join('') : '<p class="muted">None.</p>') + '</aside>';
    }

    function csv() {
      var s = P.section;
      var cols = s.fields;
      var rows = [cols.map(function (f) { return f.label; }).concat(['Editors', 'Collaborators', 'Created', 'Last updated'])];
      filtered().forEach(function (it) {
        rows.push(cols.map(function (f) { return f.type === 'currency' || f.type === 'number' ? val(it, f) : text(it, f); })
          .concat([(it.editors || []).map(person).join('; '), (it.collaborators || []).map(person).join('; '), dt(it.createdAt, true), dt(it.updatedAt, true)]));
      });
      var out = rows.map(function (r) { return r.map(function (c) { c = String(c === undefined || c === null ? '' : c); return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(','); }).join('\r\n');
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['\ufeff' + out], { type: 'text/csv;charset=utf-8' }));
      a.download = s.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') + '_archive.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    function wire() {
      var q = document.getElementById('q');
      q.addEventListener('input', function () { state.q = q.value; var pos = q.selectionStart; render(); var n = document.getElementById('q'); n.focus(); n.setSelectionRange(pos, pos); });
      document.getElementById('csv').addEventListener('click', csv);
      document.getElementById('print').addEventListener('click', function () { window.print(); });
      root.querySelectorAll('[data-stage]').forEach(function (b) { b.addEventListener('click', function () { state.stage = b.getAttribute('data-stage'); render(); }); });
      root.querySelectorAll('tr[data-id]').forEach(function (tr) {
        var go = function () { state.open = tr.getAttribute('data-id'); render(); };
        tr.addEventListener('click', go);
        tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
      });
      root.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', function () { state.open = null; render(); }); });
    }
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.open) { state.open = null; render(); } });

    if (box.encrypted) askPassword(); else { P = box.payload; render(); }
  }

  const VIEWER_CSS = [
    ':root{--bg:#f2f4f3;--surface:#fff;--ink:#18222a;--ink2:#47545e;--ink3:#75818a;--line:#e0e4e2;--accent:#a3235a;--soft:#fbe4ee;--side:#17232c;color-scheme:light}',
    '@media (prefers-color-scheme:dark){:root{--bg:#11171c;--surface:#182128;--ink:#e3e9ed;--ink2:#a8b4bd;--ink3:#7b8892;--line:#2a3640;--accent:#f08cb4;--soft:#3a1626;--side:#0c1216;color-scheme:dark}}',
    '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 "Segoe UI",system-ui,-apple-system,"Microsoft YaHei","PingFang SC",sans-serif}',
    '.boot{padding:40px 16px;color:var(--ink3)}.muted{color:var(--ink3)}.small{font-size:12px}',
    '.mark{width:40px;height:40px;border-radius:9px;background:linear-gradient(135deg,#c93a76,#7e1743);color:#fff;display:grid;place-items:center;font-weight:700;flex:none}',
    '.top{background:var(--side);color:#fff;display:flex;gap:14px;align-items:center;padding:18px max(16px,4vw)}.top h1{margin:0;font-size:24px}.top p{margin:2px 0 0;color:#b9c6cf;font-size:13px}',
    '.kick{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#9eb6c4}',
    'main{padding:18px max(16px,4vw) 40px;display:flex;flex-direction:column;gap:12px}',
    '.stages{display:flex;flex-wrap:wrap;gap:6px}.st{border:1px solid var(--line);background:var(--surface);border-radius:16px;padding:4px 11px;cursor:pointer;font:inherit;color:var(--ink);display:inline-flex;gap:6px;align-items:center}.st.on{border-color:var(--accent);background:var(--soft)}.st i{width:8px;height:8px;border-radius:50%;display:inline-block}',
    '.bar{display:flex;gap:8px;flex-wrap:wrap}.bar input{flex:1 1 240px;height:36px;border:1px solid var(--line);border-radius:7px;padding:0 10px;background:var(--surface);font:inherit;color:var(--ink)}',
    '.bar button,.lock button{height:36px;border-radius:7px;border:1px solid var(--line);background:var(--surface);padding:0 14px;cursor:pointer;font:inherit;font-weight:600;color:var(--ink)}',
    '.count{margin:0;color:var(--ink3);font-size:13px}.tw{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:9px}',
    'table{border-collapse:collapse;width:100%;font-size:13px}th{text-align:left;padding:9px 11px;background:var(--soft);white-space:nowrap;font-size:12px}td{padding:8px 11px;border-top:1px solid var(--line);vertical-align:top}',
    'tbody tr{cursor:pointer}tbody tr:hover td{background:var(--bg)}td.tt{font-weight:600;min-width:220px}td.r{text-align:right;white-space:nowrap}td.none{text-align:center;color:var(--ink3);cursor:default}',
    '.chip{display:inline-block;padding:1px 8px;border-radius:4px;font-size:12px;font-weight:600;white-space:nowrap}',
    '.c-gray{background:#eceeed;color:#66727b}.c-blue{background:#e1ecf6;color:#2a6aa0}.c-teal{background:#ddf1ef;color:#1f7f7a}.c-green{background:#e1f1e7;color:#2c7a4b}.c-amber{background:#fbeed6;color:#a96300}.c-red{background:#f9e0dd;color:#b1271f}.c-purple{background:#ece6f6;color:#6b4aa3}',
    '.f-gray{background:#66727b}.f-blue{background:#2a6aa0}.f-teal{background:#1f7f7a}.f-green{background:#2c7a4b}.f-amber{background:#a96300}.f-red{background:#b1271f}.f-purple{background:#6b4aa3}',
    '.scrim{position:fixed;inset:0;background:rgba(10,18,24,.4)}.pane{position:fixed;top:0;right:0;bottom:0;width:min(560px,100vw);background:var(--surface);overflow-y:auto;padding:22px 24px 40px;box-shadow:0 10px 40px rgba(0,0,0,.3)}',
    '.pane h2{margin:4px 0 8px;font-size:20px}.pane h3{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink3);margin:22px 0 8px}.pane .kick{color:var(--ink3)}',
    '.x{position:absolute;top:12px;right:14px;border:0;background:none;font-size:24px;cursor:pointer;color:var(--ink3)}',
    'dl{display:grid;grid-template-columns:150px 1fr;gap:6px 12px;margin:16px 0 0}dt{color:var(--ink3);font-size:12.5px}dd{margin:0}dd.long{white-space:pre-wrap}',
    '.files{padding-left:18px;margin:0}.files a{color:var(--accent)}.msg{border-top:1px solid var(--line);padding:7px 0}.msg small{color:var(--ink3)}.msg div{white-space:pre-wrap}.msg.log{color:var(--ink3);font-size:12.5px}',
    '.foot{color:var(--ink3);font-size:12.5px}',
    '.lock{min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--side)}.lock form{background:var(--surface);border-radius:12px;padding:28px;width:min(420px,100%);display:flex;flex-direction:column;gap:12px}',
    '.lock h1{margin:6px 0 0;font-size:22px}.lock p{margin:0;color:var(--ink3);font-size:13px}.lock label{display:flex;flex-direction:column;gap:6px;font-size:13px}.lock input{height:38px;border:1px solid var(--line);border-radius:7px;padding:0 10px;font:inherit;background:var(--surface);color:var(--ink)}',
    '.lock button{background:var(--accent);color:#fff;border-color:var(--accent)}.err{background:#f9e0dd;color:#b1271f;padding:8px 10px;border-radius:6px;font-size:13px}',
    '@media (max-width:600px){dl{grid-template-columns:1fr}dt{margin-top:6px}}',
    '@media print{.bar,.stages,.foot,.scrim,.pane{display:none}body{background:#fff}.tw{border:0}tbody tr{page-break-inside:avoid}}',
  ].join('');

  window.Archive = { build, read, open, FORMAT, VERSION };
})();
