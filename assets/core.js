/**
 * Sourcing Hub — shared rules.
 *
 * This one file runs in two places:
 *   - the browser (demo mode, and to decide which buttons to show)
 *   - Google Apps Script (paste it as Core.gs next to Code.gs), where it is the real gatekeeper
 *
 * It never touches Sheets or the page directly. It works through a small "store":
 *   all(table) · insert(table, rec) · save(table, rec) · del(table, id) · delWhere(table, fn)
 *   now() · uid() · saveFile(item, name, mime, base64, by) · readFile(fileId)
 */
var Core = (function () {
  'use strict';

  // Super admins have full access everywhere and cannot be switched off, deleted or given less access.
  var SUPER_ADMINS = ['sam.secov@gmail.com', 'szesian.mitosc@gmail.com', 'eileen.secov@gmail.com'];
  function isSuperId(id) { return SUPER_ADMINS.indexOf(String(id || '').toLowerCase()) >= 0; }
  var LEVELS = ['none', 'viewer', 'contributor', 'editor', 'manager'];
  var FIELD_TYPES = ['text', 'longtext', 'number', 'currency', 'percent', 'date', 'datetime', 'select', 'person', 'checkbox', 'link', 'url'];
  var COLORS = ['gray', 'blue', 'teal', 'green', 'amber', 'red', 'purple'];
  var MAX_TEXT = 5000;
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  function fail(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }
  function rank(l) { var i = LEVELS.indexOf(l || 'none'); return i < 0 ? 0 : i; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function slug(v, max) { return String(v || '').replace(/[^\w]/g, '').slice(0, max || 40); }

  // ------------------------------------------------------------ permission rules

  function level(ctx, sectionId) {
    if (ctx.me.isSuper) return 'manager';
    for (var i = 0; i < ctx.access.length; i++) {
      var a = ctx.access[i];
      if (a.sectionId === sectionId && a.userId === ctx.me.id) return a.level;
    }
    return 'none';
  }
  /**
   * Whose calendar this person may look at, as { userId: [sectionIds] | '*' }.
   * Super admins: everyone, every section. Section managers: the people on the sections they manage
   * (by access level or by being named on an item there), never a super admin. Everyone: themselves.
   */
  function monitorable(ctx, sections, items, users) {
    var out = {};
    out[ctx.me.id] = '*';
    if (ctx.me.isSuper) {
      users.forEach(function (u) { out[u.id] = '*'; });
      return out;
    }
    sections.forEach(function (s) {
      if (!live(s) || level(ctx, s.id) !== 'manager') return;
      var ids = {};
      ctx.access.forEach(function (a) { if (a.sectionId === s.id && rank(a.level) >= 1) ids[a.userId] = true; });
      items.forEach(function (it) {
        if (it.sectionId !== s.id) return;
        arr(it.editors).concat(arr(it.collaborators)).forEach(function (u) { ids[u] = true; });
      });
      Object.keys(ids).forEach(function (u) {
        if (isSuperId(u) || out[u] === '*') return;
        (out[u] = out[u] || []).push(s.id);
      });
    });
    return out;
  }

  function onItem(ctx, it) {
    return arr(it.editors).indexOf(ctx.me.id) >= 0 || arr(it.collaborators).indexOf(ctx.me.id) >= 0;
  }
  function live(s) { return s && !s.archived; }

  var can = {
    seeSection: function (ctx, s) { return ctx.me.isSuper || (live(s) && rank(level(ctx, s.id)) >= 1); },
    seeItem: function (ctx, it, s) { return ctx.me.isSuper || (live(s) && (rank(level(ctx, s.id)) >= 1 || onItem(ctx, it))); },
    create: function (ctx, s) { return ctx.me.isSuper || (live(s) && rank(level(ctx, s.id)) >= 2); },
    editItem: function (ctx, it, s) { return ctx.me.isSuper || (live(s) && (rank(level(ctx, s.id)) >= 3 || arr(it.editors).indexOf(ctx.me.id) >= 0)); },
    deleteItem: function (ctx, it, s) { return ctx.me.isSuper || (live(s) && rank(level(ctx, s.id)) >= 3); },
    comment: function (ctx, it, s) { return ctx.me.isSuper || (live(s) && (rank(level(ctx, s.id)) >= 2 || onItem(ctx, it))); },
    template: function (ctx, s) { return ctx.me.isSuper || (live(s) && rank(level(ctx, s.id)) >= 4); },
    report: function (ctx, s) { return ctx.me.isSuper || (live(s) && rank(level(ctx, s.id)) >= 4); },
  };

  // ------------------------------------------------------------ cleaning input

  function cleanFields(fields, sectionIds) {
    if (!Array.isArray(fields)) throw fail('BAD_REQUEST', 'The column list is missing.');
    if (fields.length > 60) throw fail('BAD_REQUEST', 'A section can have at most 60 columns.');
    var seen = {};
    var out = [];
    fields.forEach(function (f) {
      var key = slug(f.key);
      if (!key || seen[key]) return;
      seen[key] = true;
      var type = key === 'title' ? 'text' : (FIELD_TYPES.indexOf(f.type) >= 0 ? f.type : 'text');
      var o = { key: key, label: String(f.label || '').trim().slice(0, 80) || key, type: type };
      ['required', 'onCard'].forEach(function (k) { if (f[k]) o[k] = true; });
      if (f.due && (type === 'date' || type === 'datetime')) o.due = true;
      if (f.total && (type === 'currency' || type === 'number')) o.total = true;
      if (key === 'title') { o.required = true; o.system = true; o.onCard = true; }
      if (type === 'select') {
        var seenOpt = {};
        o.options = arr(f.options).slice(0, 60).map(function (op) {
          var r = { value: slug(op.value), label: String(op.label || '').trim().slice(0, 80), color: COLORS.indexOf(op.color) >= 0 ? op.color : 'gray' };
          var d = Number(op.alertDays);
          if (d > 0) r.alertDays = Math.min(365, Math.round(d));
          if (op.done) r.done = true;
          if (op.met && !op.done) r.met = true;
          return r;
        }).filter(function (op) {
          if (!op.value || !op.label || seenOpt[op.value]) return false;
          seenOpt[op.value] = true;
          return true;
        });
        if (!o.options.length) throw fail('BAD_REQUEST', '“' + o.label + '” needs at least one option.');
      }
      if (type === 'link') {
        o.target = sectionIds.indexOf(f.target) >= 0 ? f.target : '';
      }
      out.push(o);
    });
    if (!seen.title) out.unshift({ key: 'title', label: 'Title', type: 'text', required: true, system: true, onCard: true });
    return out;
  }

  function cleanStageField(fields, key) {
    return fields.some(function (f) { return f.key === key && f.type === 'select'; }) ? key : '';
  }

  function cleanTitle(v) {
    var t = String(v === null || v === undefined ? '' : v).trim().slice(0, 500);
    if (!t) throw fail('BAD_REQUEST', 'Give it a title.');
    return t;
  }

  function cleanData(section, data, userIds) {
    var out = {};
    section.fields.forEach(function (f) {
      if (f.key === 'title' || !Object.prototype.hasOwnProperty.call(data, f.key)) return;
      var v = data[f.key];
      switch (f.type) {
        case 'number': case 'currency': case 'percent':
          v = v === '' || v === null || v === undefined || !isFinite(Number(v)) ? '' : Number(v);
          break;
        case 'checkbox':
          v = v === true || v === 'true';
          break;
        case 'select':
          v = String(v || '');
          if (v && !arr(f.options).some(function (o) { return o.value === v; })) v = '';
          break;
        case 'person':
          v = String(v || '').toLowerCase();
          if (v && !userIds[v]) v = '';
          break;
        case 'date':
          v = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
          break;
        case 'datetime':
          v = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? v : '';
          break;
        case 'url':
          v = String(v || '').trim().slice(0, 1000);
          if (v && !/^https?:\/\//i.test(v)) v = '';
          break;
        case 'link':
          v = String(v || '').slice(0, 60);
          break;
        default:
          v = String(v === null || v === undefined ? '' : v).slice(0, MAX_TEXT);
      }
      out[f.key] = v;
    });
    return out;
  }

  function people(list, userIds) {
    var seen = {};
    return arr(list).map(function (x) { return String(x || '').toLowerCase(); })
      .filter(function (x) { if (!userIds[x] || seen[x]) return false; seen[x] = true; return true; })
      .slice(0, 50);
  }

  // ------------------------------------------------------------ sign-in

  /** Turn a verified email into a Sourcing Hub user, or refuse. */
  function identify(store, email, googleName) {
    email = String(email || '').toLowerCase();
    var isSuper = isSuperId(email);
    var u = store.all('users').filter(function (x) { return x.id === email; })[0];
    if (!u && isSuper) {
      u = { id: email, name: googleName || '', active: true, createdBy: 'system', createdAt: store.now(), updatedAt: store.now() };
      store.insert('users', u);
    }
    if (!u || (u.active === false && !isSuper)) {
      throw fail('NOT_INVITED', email + ' does not have access to Sourcing Hub. Ask the super admin to add this Google account.');
    }
    if (!u.name && googleName) {
      u.name = googleName;
      u.updatedAt = store.now();
      store.save('users', u);
    }
    return { id: u.id, name: u.name || u.id, isSuper: isSuper };
  }

  // ------------------------------------------------------------ RFQ sourcing

  var MAX_SUPPLIERS = 80;

  /** The supplier list of one RFQ task: blank rows dropped, emails checked, each email only once. */
  function cleanSuppliers(list) {
    function txt(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
    var seen = {};
    var out = [];
    arr(list).forEach(function (r) {
      r = r || {};
      var row = {
        company: txt(r.company, 200), email: txt(r.email, 200).toLowerCase(), type: txt(r.type, 40),
        country: txt(r.country, 80), source: txt(r.source, 500), note: txt(r.note, 300),
      };
      if (!row.company && !row.email) return;
      if (!EMAIL_RE.test(row.email)) throw fail('BAD_REQUEST', 'Check the email for ' + (row.company || 'this supplier') + '.');
      if (seen[row.email]) return;
      seen[row.email] = true;
      if (row.source && !/^https?:\/\//i.test(row.source)) row.source = '';
      out.push(row);
    });
    if (out.length > MAX_SUPPLIERS) throw fail('BAD_REQUEST', 'Keep the list to ' + MAX_SUPPLIERS + ' suppliers or fewer.');
    return out;
  }

  function registerSection(sections) {
    return sections.filter(function (s) { return live(s) && s.template === 'suppliers'; })[0];
  }
  /** RFQ Sourcing follows the Supplier Register: viewers look, editors change, managers approve. */
  function sourcingAccess(ctx, sections) {
    if (ctx.me.isSuper) return { view: true, edit: true, approve: true };
    var reg = registerSection(sections);
    var r = reg ? rank(level(ctx, reg.id)) : 0;
    return { view: r >= 1, edit: r >= 3, approve: r >= 4 };
  }
  function cleanTask(t) {
    t = t || {};
    function txt(v, max) { return String(v == null ? '' : v).slice(0, max); }
    if (!t.id) throw fail('BAD_REQUEST', 'This task has no RFQ Hub id.');
    return {
      id: txt(t.id, 64), hubSectionId: txt(t.hubSectionId, 64), hubSectionName: txt(t.hubSectionName, 100), title: txt(t.title, 500),
      rfqNo: txt(t.rfqNo, 100), client: txt(t.client, 200), closing: txt(t.closing, 20), items: txt(t.items, 20000),
      files: arr(t.files).slice(0, 50).map(function (f) { return { id: txt(f.id, 100), name: txt(f.name, 200), mimeType: txt(f.mimeType, 100), size: Number(f.size) || 0 }; }),
      hubUpdatedAt: txt(t.hubUpdatedAt, 40),
    };
  }

  // ------------------------------------------------------------ actions

  function handle(store, me, action, p) {
    p = p || {};
    var users = store.all('users');
    var access = store.all('access');
    var sections = store.all('sections');
    var ctx = { me: me, access: access };
    var secById = {};
    sections.forEach(function (s) { secById[s.id] = s; });
    var userIds = {};
    users.forEach(function (u) { if (u.active !== false || isSuperId(u.id)) userIds[u.id] = true; });
    var now = store.now();

    function needSuper() { if (!me.isSuper) throw fail('FORBIDDEN', 'Only the super admin can do this.'); }
    function getSection(id) {
      var s = secById[id];
      if (!s) throw fail('NOT_FOUND', 'This section no longer exists.');
      return s;
    }
    function getItem(id) {
      var it = store.all('items').filter(function (x) { return x.id === id; })[0];
      if (!it) throw fail('NOT_FOUND', 'This item was deleted by someone else.');
      return it;
    }
    function stageLog(s, it, before) {
      if (!s.stageField) return null;
      var after = (it.data || {})[s.stageField] || '';
      if ((before || '') === after) return null;
      it.stageChangedAt = now;
      var f = s.fields.filter(function (x) { return x.key === s.stageField; })[0];
      var opt = f && arr(f.options).filter(function (o) { return o.value === after; })[0];
      var log = { id: store.uid(), sectionId: s.id, itemId: it.id, kind: 'log', author: me.id, text: 'moved this to ' + (opt ? opt.label : 'no stage'), createdAt: now, updatedAt: now };
      store.insert('comments', log);
      return log;
    }

    switch (action) {
      case 'bootstrap': {
        var items = store.all('items').filter(function (it) { return can.seeItem(ctx, it, secById[it.sectionId]); });
        var vis = {};
        var withItems = {};
        items.forEach(function (it) { vis[it.id] = true; withItems[it.sectionId] = true; });
        return {
          me: me,
          users: users.map(function (u) { return { id: u.id, name: u.name || '', active: u.active !== false }; }),
          sections: sections
            .filter(function (s) { return me.isSuper || (live(s) && (rank(level(ctx, s.id)) >= 1 || withItems[s.id])); })
            .sort(function (a, b) { return (Number(a.order) || 0) - (Number(b.order) || 0); })
            .map(function (s) { var c = clone(s); c.myLevel = level(ctx, s.id); return c; }),
          items: items,
          comments: store.all('comments').filter(function (c) { return vis[c.itemId]; }),
          sourcing: sourcingAccess(ctx, sections).view ? store.all('sourcing') : [],
          // Own rows, plus everyone's rows on sections this person manages (managers see who is on their team).
          access: me.isSuper ? access : access.filter(function (a) {
            return a.userId === me.id || (live(secById[a.sectionId]) && level(ctx, a.sectionId) === 'manager');
          }),
        };
      }

      case 'item.create': {
        var s1 = getSection(p.sectionId);
        if (!can.create(ctx, s1)) throw fail('FORBIDDEN', 'You cannot add items to ' + s1.name + '.');
        var it1 = {
          id: store.uid(), sectionId: s1.id, title: cleanTitle(p.title), data: cleanData(s1, p.data || {}, userIds),
          editors: people(p.editors, userIds), collaborators: people(p.collaborators, userIds), files: [],
          stageChangedAt: now, createdBy: me.id, createdAt: now, updatedAt: now,
        };
        var sf1 = s1.stageField && s1.fields.filter(function (f) { return f.key === s1.stageField; })[0];
        if (sf1 && !it1.data[sf1.key] && sf1.options.length) it1.data[sf1.key] = sf1.options[0].value;
        // A contributor keeps the right to edit what they create.
        if (!me.isSuper && rank(level(ctx, s1.id)) < 3 && it1.editors.indexOf(me.id) < 0) it1.editors.push(me.id);
        it1.collaborators = it1.collaborators.filter(function (x) { return it1.editors.indexOf(x) < 0; });
        store.insert('items', it1);
        return { item: it1 };
      }

      case 'item.update': {
        var it2 = getItem(p.id);
        var s2 = getSection(it2.sectionId);
        if (!can.editItem(ctx, it2, s2)) throw fail('FORBIDDEN', 'You can view this item but not change it.');
        var patch = p.patch || {};
        var before = s2.stageField ? (it2.data || {})[s2.stageField] : '';
        if ('title' in patch) it2.title = cleanTitle(patch.title);
        if (patch.data) it2.data = Object.assign({}, it2.data || {}, cleanData(s2, patch.data, userIds));
        if (patch.editors) it2.editors = people(patch.editors, userIds);
        if (patch.collaborators) it2.collaborators = people(patch.collaborators, userIds);
        it2.collaborators = arr(it2.collaborators).filter(function (x) { return arr(it2.editors).indexOf(x) < 0; });
        var log = stageLog(s2, it2, before);
        it2.updatedAt = now;
        store.save('items', it2);
        return { item: it2, log: log };
      }

      case 'item.remove': {
        var it3 = getItem(p.id);
        if (!can.deleteItem(ctx, it3, getSection(it3.sectionId))) throw fail('FORBIDDEN', 'Only section editors and managers can delete items.');
        store.del('items', it3.id);
        store.delWhere('comments', function (c) { return c.itemId === it3.id; });
        return { id: it3.id };
      }

      case 'sourcing.import': {
        // A copy of an RFQ Hub task. Importing again refreshes the copy and keeps the supplier list and approval.
        if (!sourcingAccess(ctx, sections).edit) throw fail('FORBIDDEN', 'You can view RFQ Sourcing but not change it.');
        var task = cleanTask(p.task);
        var had = store.all('sourcing').filter(function (r) { return r.id === task.id; })[0];
        var imp = Object.assign({ status: 'draft', suppliers: [], emailSubject: '', deliveryLocation: '', approvedBy: '', approvedAt: '', createdBy: me.id, createdAt: now }, had || {}, task, { updatedAt: now });
        if (had) store.save('sourcing', imp); else store.insert('sourcing', imp);
        return { sourcing: imp };
      }

      case 'sourcing.save':
      case 'sourcing.approve': {
        // Saving any change puts the list back to draft, so an approval always covers exactly what was reviewed.
        var access7 = sourcingAccess(ctx, sections);
        if (!access7.edit) throw fail('FORBIDDEN', 'You can view RFQ Sourcing but not change it.');
        var approving = action === 'sourcing.approve';
        if (approving && !access7.approve) throw fail('FORBIDDEN', 'Only a Supplier Register manager or super admin can approve the supplier list.');
        var prior = store.all('sourcing').filter(function (r) { return r.id === p.itemId; })[0];
        if (!prior) throw fail('NOT_FOUND', 'This task is no longer in RFQ Sourcing.');
        var suppliers = cleanSuppliers(p.suppliers);
        if (approving && !suppliers.length) throw fail('BAD_REQUEST', 'Add at least one supplier before approving.');
        var rec = Object.assign({}, prior, {
          status: approving ? 'approved' : 'draft', suppliers: suppliers,
          emailSubject: String(p.emailSubject || '').trim().slice(0, 300), deliveryLocation: String(p.deliveryLocation || '').trim().slice(0, 200),
          approvedBy: approving ? me.id : '', approvedAt: approving ? now : '', updatedAt: now,
        });
        store.save('sourcing', rec);
        return { sourcing: rec };
      }

      case 'sourcing.remove': {
        if (!sourcingAccess(ctx, sections).edit) throw fail('FORBIDDEN', 'You can view RFQ Sourcing but not change it.');
        store.del('sourcing', p.itemId);
        return { id: p.itemId };
      }

      case 'item.upload': {
        var it4 = getItem(p.id);
        if (!can.editItem(ctx, it4, getSection(it4.sectionId))) throw fail('FORBIDDEN', 'You cannot attach files to this item.');
        var meta = store.saveFile(it4, String(p.fileName || 'file').slice(0, 200), String(p.mimeType || 'application/octet-stream'), String(p.base64 || ''), me.id);
        it4.files = arr(it4.files).concat([meta]);
        it4.updatedAt = now;
        store.save('items', it4);
        return { item: it4 };
      }

      case 'item.file': {
        var it5 = getItem(p.id);
        if (!can.seeItem(ctx, it5, getSection(it5.sectionId))) throw fail('FORBIDDEN', 'You do not have access to this file.');
        if (!arr(it5.files).some(function (f) { return f.id === p.fileId; })) throw fail('NOT_FOUND', 'This file is no longer attached.');
        return store.readFile(p.fileId);
      }

      case 'comment.create': {
        var it6 = getItem(p.itemId);
        if (!can.comment(ctx, it6, getSection(it6.sectionId))) throw fail('FORBIDDEN', 'You cannot comment on this item.');
        var text = String(p.text || '').trim().slice(0, MAX_TEXT);
        if (!text) throw fail('BAD_REQUEST', 'Write something first.');
        var c = { id: store.uid(), sectionId: it6.sectionId, itemId: it6.id, kind: 'comment', author: me.id, text: text, createdAt: now, updatedAt: now };
        store.insert('comments', c);
        return { comment: c };
      }

      case 'section.create': {
        needSuper();
        var ids = sections.map(function (s) { return s.id; });
        var fields = cleanFields(p.fields || [], ids);
        var sec = {
          id: store.uid(), name: String(p.name || '').trim().slice(0, 60), template: slug(p.template),
          order: sections.reduce(function (m, s) { return Math.max(m, Number(s.order) || 0); }, 0) + 1,
          fields: fields, stageField: cleanStageField(fields, p.stageField), archived: false,
          createdBy: me.id, createdAt: now, updatedAt: now,
        };
        if (!sec.name) throw fail('BAD_REQUEST', 'Give the section a name.');
        store.insert('sections', sec);
        return { section: sec };
      }

      case 'section.update': {
        var s7 = getSection(p.id);
        var sp = p.patch || {};
        if ('archived' in sp || 'order' in sp) needSuper();
        else if (!can.template(ctx, s7)) throw fail('FORBIDDEN', 'Only the super admin or this section’s managers can change its columns.');
        if ('name' in sp) {
          s7.name = String(sp.name || '').trim().slice(0, 60);
          if (!s7.name) throw fail('BAD_REQUEST', 'Give the section a name.');
        }
        if ('fields' in sp) s7.fields = cleanFields(sp.fields, sections.map(function (s) { return s.id; }));
        if ('fields' in sp || 'stageField' in sp) s7.stageField = cleanStageField(s7.fields, 'stageField' in sp ? sp.stageField : s7.stageField);
        if ('archived' in sp) s7.archived = !!sp.archived;
        if ('order' in sp) s7.order = Number(sp.order) || 0;
        s7.updatedAt = now;
        store.save('sections', s7);
        var c7 = clone(s7);
        c7.myLevel = level(ctx, s7.id);
        return { section: c7 };
      }

      case 'section.delete': {
        // Permanently delete a section and everything in it from storage. Cannot be undone.
        needSuper();
        var ds = getSection(p.id);
        if (String(p.confirmName || '').trim().toLowerCase() !== String(ds.name).trim().toLowerCase()) {
          throw fail('BAD_REQUEST', 'Type the section name exactly to confirm.');
        }
        var gone = {};
        store.all('items').forEach(function (it) { if (it.sectionId === ds.id) gone[it.id] = true; });
        store.delWhere('comments', function (c) { return c.sectionId === ds.id || gone[c.itemId]; });
        store.delWhere('items', function (it) { return it.sectionId === ds.id; });
        store.delWhere('access', function (a) { return a.sectionId === ds.id; });
        store.del('sections', ds.id);
        return { id: ds.id, itemIds: Object.keys(gone) };
      }

      case 'section.restore': {
        // Bring a section back from an archive file. Never touches existing data.
        // If the original section and its items are gone, their original ids are reused, so links from
        // other sections, shared item links and calendar events reconnect. Otherwise it becomes a new copy.
        needSuper();
        var src = p.section || {};
        var oldId = String(src.id || '');
        var rIds = sections.map(function (s) { return s.id; });
        var srcItems = arr(p.items).slice(0, 5000);
        var taken = {};
        store.all('items').forEach(function (it) { taken[it.id] = true; });
        var idOk = function (v) { return /^[\w-]{1,60}$/.test(String(v || '')); };
        var reuse = idOk(oldId) && !secById[oldId] && srcItems.every(function (it) { return idOk(it.id) && !taken[it.id]; });
        var newId = reuse ? oldId : store.uid();
        var rFields = cleanFields((src.fields || []).map(function (f) {
          var c = clone(f);
          if (c.type === 'link' && c.target === oldId) c.target = newId; // links inside the archived section
          return c;
        }), rIds.concat([newId]));
        var rName = String(p.name || src.name || '').trim().slice(0, 60);
        if (!rName) throw fail('BAD_REQUEST', 'Give the section a name.');
        var rSec = {
          id: newId, name: rName, template: slug(src.template),
          order: sections.reduce(function (m, s) { return Math.max(m, Number(s.order) || 0); }, 0) + 1,
          fields: rFields, stageField: cleanStageField(rFields, src.stageField), archived: false,
          createdBy: me.id, createdAt: now, updatedAt: now,
        };
        var idMap = {};
        srcItems.forEach(function (it) { idMap[String(it.id)] = reuse ? String(it.id) : store.uid(); });
        var selfLinks = rFields.filter(function (f) { return f.type === 'link' && f.target === newId; }).map(function (f) { return f.key; });
        var newItems = srcItems.map(function (it) {
          var data = cleanData(rSec, it.data || {}, userIds);
          selfLinks.forEach(function (k) { if (data[k]) data[k] = idMap[data[k]] || ''; });
          var eds = people(it.editors, userIds);
          return {
            id: idMap[String(it.id)], sectionId: newId, title: String(it.title || 'Untitled').trim().slice(0, 500) || 'Untitled', data: data,
            editors: eds, collaborators: people(it.collaborators, userIds).filter(function (x) { return eds.indexOf(x) < 0; }),
            files: arr(it.files).slice(0, 200).map(function (f) {
              return { id: String(f.id || '').replace(/[^\w-]/g, '').slice(0, 120), name: String(f.name || '').slice(0, 200), mimeType: String(f.mimeType || '').slice(0, 100), size: Number(f.size) || 0, uploadedBy: String(f.uploadedBy || '').slice(0, 120), uploadedAt: String(f.uploadedAt || '').slice(0, 40) };
            }),
            stageChangedAt: String(it.stageChangedAt || now).slice(0, 40), createdBy: String(it.createdBy || me.id).slice(0, 120),
            createdAt: String(it.createdAt || now).slice(0, 40), updatedAt: String(it.updatedAt || now).slice(0, 40),
          };
        });
        var newComments = arr(p.comments).filter(function (c) { return idMap[String(c.itemId)]; }).slice(0, 20000).map(function (c) {
          return {
            id: store.uid(), sectionId: newId, itemId: idMap[String(c.itemId)], kind: c.kind === 'log' ? 'log' : 'comment',
            author: String(c.author || '').slice(0, 120), text: String(c.text || '').slice(0, MAX_TEXT),
            createdAt: String(c.createdAt || now).slice(0, 40), updatedAt: String(c.updatedAt || now).slice(0, 40),
          };
        });
        var newAccess = !p.withAccess ? [] : arr(p.access).filter(function (a) {
          return userIds[a.userId] && !isSuperId(a.userId) && rank(a.level) >= 1;
        }).map(function (a) {
          return { id: store.uid(), sectionId: newId, userId: a.userId, level: LEVELS[rank(a.level)], createdBy: me.id, createdAt: now, updatedAt: now };
        });
        var many = store.insertMany || function (t, recs) { recs.forEach(function (r) { store.insert(t, r); }); };
        store.insert('sections', rSec);
        if (newItems.length) many('items', newItems);
        if (newComments.length) many('comments', newComments);
        if (newAccess.length) many('access', newAccess);
        var out = clone(rSec);
        out.myLevel = 'manager';
        return { section: out, items: newItems, comments: newComments, access: newAccess, reusedIds: reuse };
      }

      case 'user.create': {
        needSuper();
        var id = String(p.id || '').trim().toLowerCase();
        if (!EMAIL_RE.test(id)) throw fail('BAD_REQUEST', 'Enter a valid Google email.');
        if (users.some(function (u) { return u.id === id; })) throw fail('BAD_REQUEST', id + ' already has an account.');
        var u = { id: id, name: String(p.name || '').trim().slice(0, 80), active: p.active !== false, createdBy: me.id, createdAt: now, updatedAt: now };
        store.insert('users', u);
        return { user: { id: u.id, name: u.name, active: u.active } };
      }

      case 'user.update': {
        needSuper();
        var u2 = users.filter(function (x) { return x.id === p.id; })[0];
        if (!u2) throw fail('NOT_FOUND', 'This account no longer exists.');
        var up = p.patch || {};
        if ('name' in up) u2.name = String(up.name || '').trim().slice(0, 80);
        if ('active' in up) {
          if (isSuperId(u2.id) && !up.active) throw fail('BAD_REQUEST', 'A super admin account cannot be switched off.');
          u2.active = !!up.active;
        }
        u2.updatedAt = now;
        store.save('users', u2);
        return { user: { id: u2.id, name: u2.name, active: u2.active !== false } };
      }

      case 'user.remove': {
        needSuper();
        if (isSuperId(p.id)) throw fail('BAD_REQUEST', 'A super admin account cannot be deleted.');
        store.del('users', p.id);
        store.delWhere('access', function (a) { return a.userId === p.id; });
        return { id: p.id };
      }

      case 'access.set': {
        needSuper();
        getSection(p.sectionId);
        if (!users.some(function (x) { return x.id === p.userId; })) throw fail('NOT_FOUND', 'This account no longer exists.');
        if (isSuperId(p.userId)) throw fail('BAD_REQUEST', 'Super admins already have full access everywhere.');
        var lv = LEVELS.indexOf(p.level) >= 0 ? p.level : 'none';
        var row = access.filter(function (a) { return a.sectionId === p.sectionId && a.userId === p.userId; })[0];
        if (lv === 'none') {
          if (row) store.del('access', row.id);
          return { access: null, sectionId: p.sectionId, userId: p.userId };
        }
        if (row) {
          row.level = lv;
          row.updatedAt = now;
          store.save('access', row);
        } else {
          row = { id: store.uid(), sectionId: p.sectionId, userId: p.userId, level: lv, createdBy: me.id, createdAt: now, updatedAt: now };
          store.insert('access', row);
        }
        return { access: row, sectionId: p.sectionId, userId: p.userId };
      }

      default:
        throw fail('BAD_REQUEST', 'Unknown action: ' + action);
    }
  }

  return {
    SUPER_ADMINS: SUPER_ADMINS, isSuperId: isSuperId, LEVELS: LEVELS, FIELD_TYPES: FIELD_TYPES, COLORS: COLORS,
    rank: rank, level: level, can: can, sourcingAccess: sourcingAccess, monitorable: monitorable, fail: fail, identify: identify, handle: handle, cleanFields: cleanFields,
  };
})();
