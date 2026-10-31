/**
 * Sourcing Hub — Google Apps Script backend
 *
 * The Apps Script project has TWO files:
 *   Code.gs  — this file: Google Sheets storage, Google Drive files, sign-in check
 *   Core.gs  — a copy of assets/core.js: who may see and change what
 *
 * Deploy this from proc.sec1@gmail.com: the RFQ emails will be sent from the deploying account.
 *
 * Setup (see README.md):
 *   1. Fill in CLIENT_ID below.
 *   2. Run setup() once from the editor and approve the permissions.
 *   3. Deploy > New deployment > Web app: Execute as "Me", access "Anyone".
 *
 * Super admins are fixed in Core.gs (SUPER_ADMINS) and cannot be removed.
 *
 * Google Calendar: every item whose section has a Deadline column gets an event in the
 * "Sourcing Hub" calendar of the account that deploys this script. The item's editors,
 * collaborators and named people are added as guests, so it shows in their own Google Calendar.
 */

const CLIENT_ID = '565076969693-m0aeshobnlvb0p542p3flt0g6cudjopi.apps.googleusercontent.com';
const APP_URL = 'https://asana-sec.github.io/sourcing-hub/';
// false: guests are added quietly. true: Google also emails an invitation the first time.
const SEND_INVITE_EMAILS = false;
const TIMED_EVENT_MINUTES = 30;

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const TABLES = {
  users: ['id', 'name', 'active', 'createdBy', 'createdAt', 'updatedAt'],
  sections: ['id', 'name', 'template', 'order', 'fields', 'stageField', 'archived', 'createdBy', 'createdAt', 'updatedAt'],
  access: ['id', 'sectionId', 'userId', 'level', 'createdBy', 'createdAt', 'updatedAt'],
  items: ['id', 'sectionId', 'title', 'data', 'editors', 'collaborators', 'files', 'stageChangedAt', 'createdBy', 'createdAt', 'updatedAt'],
  comments: ['id', 'sectionId', 'itemId', 'kind', 'author', 'text', 'createdAt', 'updatedAt'],
  calendar: ['id', 'eventId', 'updatedAt'], // id = item id
  sourcing: ['id', 'hubSectionId', 'hubSectionName', 'title', 'rfqNo', 'client', 'closing', 'items', 'files', 'hubUpdatedAt', 'status', 'suppliers', 'emailSubject', 'deliveryLocation', 'approvedBy', 'approvedAt', 'createdBy', 'createdAt', 'updatedAt', 'mailFiles'], // id = RFQ Hub item id
  emails: ['id', 'taskId', 'email', 'company', 'cc', 'subject', 'body', 'draftId', 'messageId', 'threadId', 'status', 'error', 'listApprovedAt', 'createdBy', 'createdAt', 'sentBy', 'sentAt', 'updatedAt'],
  settings: ['id', 'fromEmail', 'cc', 'signature', 'updatedBy', 'updatedAt'], // private to this Sheet: the repository is public
};
const JSON_COLS = ['fields', 'data', 'editors', 'collaborators', 'files', 'suppliers', 'mailFiles'];
const BOOL_COLS = ['active', 'archived'];
const NUM_COLS = ['order'];
const READ_ONLY_ACTIONS = ['bootstrap', 'item.file', 'mail.status'];

// ---------------------------------------------------------------- setup

/** Run once from the editor. Safe to run again: it only adds what is missing. */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let ss;
  const sheetId = props.getProperty('SHEET_ID');
  if (sheetId) {
    ss = SpreadsheetApp.openById(sheetId);
  } else {
    ss = SpreadsheetApp.create('Sourcing Hub — Data');
    props.setProperty('SHEET_ID', ss.getId());
  }

  Object.keys(TABLES).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const cols = TABLES[name];
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    try {
      sh.getRange(1, 1, 1, cols.length).setFontWeight('bold');
      sh.setFrozenRows(1);
      // Keep dates and codes as typed text; numbers are coerced on read.
      sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
    } catch (e) {
      // A Google Sheets "Table" with typed columns refuses formatting and may reject the app's data.
      Logger.log('WARNING: tab "' + name + '" is a Google Sheets Table (' + e.message + '). Convert it back to a normal range: click the table, open its menu and choose to revert or convert to a range.');
    }
  });
  const blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);

  if (!props.getProperty('FOLDER_ID')) {
    props.setProperty('FOLDER_ID', DriveApp.createFolder('Sourcing Hub — Files').getId());
  }

  let calId = props.getProperty('CALENDAR_ID');
  if (!calId || !CalendarApp.getCalendarById(calId)) {
    const cal = CalendarApp.createCalendar('Sourcing Hub', { summary: 'Deadlines from Sourcing Hub. Edit items in the app, not here.', timeZone: Session.getScriptTimeZone() });
    calId = cal.getId();
    props.setProperty('CALENDAR_ID', calId);
  }

  // Creates the super admins' account rows.
  const store = sheetStore_();
  Core.SUPER_ADMINS.forEach(function (email) { Core.identify(store, email, ''); });

  Logger.log('Sheet:    ' + ss.getUrl());
  Logger.log('Folder:   ' + DriveApp.getFolderById(props.getProperty('FOLDER_ID')).getUrl());
  Logger.log('Calendar: Sourcing Hub (' + calId + ')');
  Logger.log('Super admins: ' + Core.SUPER_ADMINS.join(', '));
  // Touching Gmail here makes Google ask for the mail permission while someone is at the keyboard.
  Logger.log('Sends as: ' + Session.getEffectiveUser().getEmail() + ' (' + GmailApp.getDrafts().length + ' drafts, ' + MailApp.getRemainingDailyQuota() + ' recipients left today)');
}

/** Run from the editor to rebuild every Google Calendar event (for example after changing many items). */
function syncAllCalendar() {
  const r = resyncCalendar_(sheetStore_(), null, 5 * 60 * 1000);
  Logger.log('Synced ' + r.synced + ' items, ' + r.remaining + ' left. Run again if anything is left.');
}

// ---------------------------------------------------------------- HTTP

function doGet() {
  return json_({ ok: true, app: 'sourcing-hub' });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const ident = verifyGoogle_(req.token);
    const run = function () {
      const store = sheetStore_();
      const me = Core.identify(store, ident.email, ident.name);
      if (req.action === 'calendar.resync') {
        if (!me.isSuper) throw Core.fail('FORBIDDEN', 'Only a super admin can do this.');
        return resyncCalendar_(store, null, 4 * 60 * 1000);
      }
      const result = Core.handle(store, me, req.action, req.payload || {});
      try {
        afterChange_(store, req.action, result);
      } catch (calErr) {
        // The change itself is saved; a calendar problem must not undo it.
        console.error('Calendar sync failed: ' + calErr);
      }
      return result;
    };
    const data = READ_ONLY_ACTIONS.indexOf(req.action) >= 0 ? run() : withLock_(run);
    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, code: err.code || 'ERROR', error: String(err.message || err) });
  }
}

// ---------------------------------------------------------------- Google Calendar

function calendar_() {
  const id = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  return id ? CalendarApp.getCalendarById(id) : null;
}

function afterChange_(store, action, result) {
  if (!calendar_()) return;
  if (action === 'item.create' || action === 'item.update') syncItem_(store, result.item);
  else if (action === 'item.remove') dropEvent_(store, result.id);
  else if (action === 'section.update') resyncCalendar_(store, result.section.id, 90 * 1000);
  else if (action === 'section.restore') resyncCalendar_(store, result.section.id, 120 * 1000);
  else if (action === 'section.delete') dropEvents_(store, result.itemIds);
}

/** Create, update or remove the Google Calendar event for one item. */
function syncItem_(store, item) {
  const cal = calendar_();
  const s = store.all('sections').filter(function (x) { return x.id === item.sectionId; })[0];
  const link = store.all('calendar').filter(function (r) { return r.id === item.id; })[0];
  const due = s && !s.archived && s.fields.filter(function (f) { return f.due; })[0];
  const v = due && item.data ? item.data[due.key] : '';
  if (!v) {
    if (link) dropEvent_(store, item.id);
    return;
  }

  const users = {};
  store.all('users').forEach(function (u) { if (u.active !== false) users[u.id] = u; });
  const people = [].concat(item.editors || [], item.collaborators || []);
  s.fields.forEach(function (f) { if (f.type === 'person' && item.data[f.key]) people.push(item.data[f.key]); });
  const guests = people.filter(function (id, i) { return users[id] && people.indexOf(id) === i; });

  const stageF = s.stageField && s.fields.filter(function (f) { return f.key === s.stageField; })[0];
  const stage = stageF && (stageF.options || []).filter(function (o) { return o.value === item.data[s.stageField]; })[0];
  const name = function (id) { return (users[id] && users[id].name) || id; };
  const title = (stage && stage.done ? '✓ ' : '') + item.title + ' — ' + s.name;
  const desc = [
    s.name + (stage ? ' · ' + stage.label : ''),
    (item.editors || []).length ? 'Editors: ' + item.editors.map(name).join(', ') : '',
    (item.collaborators || []).length ? 'Collaborators: ' + item.collaborators.map(name).join(', ') : '',
    '',
    'Open in Sourcing Hub: ' + APP_URL + '#item/' + item.id,
  ].filter(function (x, i) { return x || i === 3; }).join('\n');

  const tz = Session.getScriptTimeZone();
  const allDay = !/T\d/.test(v);
  const start = allDay ? Utilities.parseDate(v.slice(0, 10), tz, 'yyyy-MM-dd') : Utilities.parseDate(v.slice(0, 16), tz, "yyyy-MM-dd'T'HH:mm");
  const end = new Date(start.getTime() + TIMED_EVENT_MINUTES * 60000);

  let ev = null;
  if (link) { try { ev = cal.getEventById(link.eventId); } catch (e) { ev = null; } }
  if (!ev) {
    const opts = { description: desc, guests: guests.join(','), sendInvites: SEND_INVITE_EMAILS };
    ev = allDay ? cal.createAllDayEvent(title, start, opts) : cal.createEvent(title, start, end, opts);
    ev.setGuestsCanModify(false);
    ev.setGuestsCanInviteOthers(false);
    const row = { id: item.id, eventId: ev.getId(), updatedAt: new Date().toISOString() };
    if (link) store.save('calendar', row); else store.insert('calendar', row);
    return;
  }
  ev.setTitle(title);
  ev.setDescription(desc);
  if (allDay) ev.setAllDayDate(start); else ev.setTime(start, end);
  const current = ev.getGuestList().map(function (g) { return g.getEmail().toLowerCase(); });
  guests.forEach(function (g) { if (current.indexOf(g) < 0) ev.addGuest(g); });
  current.forEach(function (g) { if (guests.indexOf(g) < 0) ev.removeGuest(g); });
  link.updatedAt = new Date().toISOString();
  store.save('calendar', link);
}

function dropEvent_(store, itemId) {
  const link = store.all('calendar').filter(function (r) { return r.id === itemId; })[0];
  if (!link) return;
  try {
    const ev = calendar_().getEventById(link.eventId);
    if (ev) ev.deleteEvent();
  } catch (e) {
    // Already gone from the calendar.
  }
  store.del('calendar', itemId);
}

/** Delete the calendar events of many items at once (used when a section is deleted). */
function dropEvents_(store, itemIds) {
  const want = {};
  (itemIds || []).forEach(function (id) { want[id] = true; });
  const links = store.all('calendar').filter(function (r) { return want[r.id]; });
  if (!links.length) return;
  const cal = calendar_();
  links.forEach(function (r) {
    try { const ev = cal.getEventById(r.eventId); if (ev) ev.deleteEvent(); } catch (e) { /* already gone */ }
  });
  store.delWhere('calendar', function (r) { return want[r.id]; });
}

/** Sync many items within a time budget; returns how many were done and how many are left. */
function resyncCalendar_(store, sectionId, budgetMs) {
  if (!calendar_()) throw Core.fail('SETUP', 'Run setup() in the Apps Script editor first, so the Sourcing Hub calendar exists.');
  const startAt = Date.now();
  const items = store.all('items').filter(function (it) { return !sectionId || it.sectionId === sectionId; });
  let done = 0;
  for (let i = 0; i < items.length; i++) {
    if (Date.now() - startAt > budgetMs) break;
    try { syncItem_(store, items[i]); } catch (e) { console.error('Calendar sync failed for ' + items[i].id + ': ' + e); }
    done++;
  }
  // Events whose item no longer exists
  if (!sectionId && done === items.length) {
    const ids = {};
    items.forEach(function (it) { ids[it.id] = true; });
    store.all('calendar').forEach(function (r) { if (!ids[r.id]) dropEvent_(store, r.id); });
  }
  return { synced: done, remaining: items.length - done };
}

// ---------------------------------------------------------------- Google sign-in check

function verifyGoogle_(token) {
  if (!token) throw Core.fail('AUTH_REQUIRED', 'Please sign in.');
  const cache = CacheService.getScriptCache();
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token);
  const key = 'tok_' + Utilities.base64EncodeWebSafe(digest).slice(0, 43);
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  const res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw Core.fail('AUTH_INVALID', 'Your sign-in has expired. Please sign in again.');
  const info = JSON.parse(res.getContentText());
  const now = Math.floor(Date.now() / 1000);
  if (info.aud !== CLIENT_ID) throw Core.fail('AUTH_INVALID', 'This sign-in belongs to a different app.');
  if (String(info.email_verified) !== 'true') throw Core.fail('AUTH_INVALID', 'Your Google email is not verified.');
  if (Number(info.exp) <= now) throw Core.fail('AUTH_EXPIRED', 'Your sign-in has expired. Please sign in again.');

  const ident = { email: String(info.email).toLowerCase(), name: info.name || '' };
  cache.put(key, JSON.stringify(ident), Math.max(30, Math.min(600, Number(info.exp) - now - 30)));
  return ident;
}

// ---------------------------------------------------------------- Sheets store used by Core

function sheetStore_() {
  const cache = {};
  function rows(t) {
    if (!cache[t]) cache[t] = load_(t);
    return cache[t];
  }
  function copy(o) { return JSON.parse(JSON.stringify(o)); }
  return {
    all: function (t) { return rows(t).map(function (x) { return copy(x.rec); }); },
    insert: function (t, rec) {
      sheet_(t).appendRow(toRow_(t, rec));
      delete cache[t];
    },
    insertMany: function (t, recs) {
      // One write for many rows (used when restoring an archive)
      const sh = sheet_(t);
      const rows = recs.map(function (r) { return toRow_(t, r); });
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, TABLES[t].length).setValues(rows);
      delete cache[t];
    },
    save: function (t, rec) {
      const x = rows(t).filter(function (r) { return r.rec.id === rec.id; })[0];
      if (!x) throw Core.fail('NOT_FOUND', 'This record was deleted by someone else.');
      const row = toRow_(t, rec);
      sheet_(t).getRange(x.row, 1, 1, row.length).setValues([row]);
      x.rec = copy(rec);
    },
    del: function (t, id) {
      const x = rows(t).filter(function (r) { return r.rec.id === id; })[0];
      if (x) sheet_(t).deleteRow(x.row);
      delete cache[t];
    },
    delWhere: function (t, fn) {
      const all = rows(t);
      const hits = all.filter(function (r) { return fn(r.rec); });
      if (!hits.length) return;
      const sh = sheet_(t);
      if (hits.length <= 10) {
        hits.sort(function (a, b) { return b.row - a.row; }).forEach(function (x) { sh.deleteRow(x.row); });
      } else {
        // Many rows: rewrite the table once instead of deleting row by row
        const width = TABLES[t].length;
        const last = sh.getLastRow();
        const raw = last > 1 ? sh.getRange(2, 1, last - 1, width).getValues() : [];
        const drop = {};
        hits.forEach(function (x) { drop[x.row] = true; });
        const keep = raw.filter(function (r, i) { return !drop[i + 2]; });
        if (last > 1) sh.getRange(2, 1, last - 1, width).clearContent();
        if (keep.length) sh.getRange(2, 1, keep.length, width).setValues(keep);
      }
      delete cache[t];
    },
    mail: {
      status: function () { return { account: Session.getEffectiveUser().getEmail(), remaining: MailApp.getRemainingDailyQuota() }; },
      createDraft: function (m) {
        const d = GmailApp.createDraft(m.to, m.subject, m.body, mailOptions_(m));
        return { draftId: d.getId(), messageId: d.getMessage().getId() };
      },
      deleteDraft: function (id) {
        try { GmailApp.getDraft(id).deleteDraft(); } catch (e) { /* already gone from Gmail */ }
      },
      sendDraft: function (id) {
        const msg = GmailApp.getDraft(id).send();
        return { messageId: msg.getId(), threadId: msg.getThread().getId() };
      },
      sendTest: function (m) { GmailApp.sendEmail(m.to, m.subject, m.body, mailOptions_(m)); },
    },
    now: function () { return new Date().toISOString(); },
    uid: function () { return Utilities.getUuid().replace(/-/g, '').slice(0, 16); },
    saveFile: function (item, name, mime, base64, by) {
      const bytes = Utilities.base64Decode(base64);
      if (!bytes.length) throw Core.fail('BAD_REQUEST', 'The file is empty.');
      if (bytes.length > MAX_UPLOAD_BYTES) throw Core.fail('BAD_REQUEST', 'Files must be 20 MB or smaller.');
      const root = DriveApp.getFolderById(prop_('FOLDER_ID'));
      const folder = subfolder_(subfolder_(root, item.sectionId), item.id);
      const file = folder.createFile(Utilities.newBlob(bytes, mime, name));
      return { id: file.getId(), name: name, mimeType: file.getMimeType(), size: bytes.length, uploadedBy: by, uploadedAt: new Date().toISOString() };
    },
    readFile: function (fileId) {
      const file = DriveApp.getFileById(fileId);
      const blob = file.getBlob();
      return { name: file.getName(), mimeType: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()) };
    },
  };
}

/** Plain text and an HTML copy with the same line breaks, so Gmail does not re-wrap item lists. */
function mailOptions_(m) {
  const html = String(m.body).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  const options = { htmlBody: '<div style="font-family:Arial,sans-serif;font-size:14px">' + html + '</div>' };
  if (m.cc) options.cc = m.cc.split('; ').join(',');
  if (m.fileIds && m.fileIds.length) options.attachments = m.fileIds.map(function (id) { return DriveApp.getFileById(id).getBlob(); });
  return options;
}

function sheet_(name) {
  const sh = SpreadsheetApp.openById(prop_('SHEET_ID')).getSheetByName(name);
  if (!sh) throw Core.fail('SETUP', 'Run setup() in the Apps Script editor first.');
  return sh;
}

function load_(name) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const cols = TABLES[name];
  return sh.getRange(2, 1, last - 1, cols.length).getValues()
    .map(function (r, i) { return { rec: fromRow_(name, r), row: i + 2 }; })
    .filter(function (x) { return x.rec.id; });
}

function fromRow_(name, row) {
  const rec = {};
  TABLES[name].forEach(function (c, i) {
    let v = row[i];
    if (v instanceof Date) v = Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm");
    if (JSON_COLS.indexOf(c) >= 0) {
      try { v = v ? JSON.parse(v) : (c === 'data' ? {} : []); } catch (e) { v = c === 'data' ? {} : []; }
    } else if (BOOL_COLS.indexOf(c) >= 0) {
      v = v === true || String(v).toLowerCase() === 'true';
    } else if (NUM_COLS.indexOf(c) >= 0) {
      v = Number(v) || 0;
    } else {
      v = v === null || v === undefined ? '' : String(v);
    }
    rec[c] = v;
  });
  return rec;
}

function toRow_(name, rec) {
  return TABLES[name].map(function (c) {
    const v = rec[c];
    if (v === undefined || v === null) return '';
    if (JSON_COLS.indexOf(c) >= 0) return JSON.stringify(v);
    if (typeof v === 'string' && /^[=+]/.test(v)) return "'" + v; // never run as a formula
    return v;
  });
}

// ---------------------------------------------------------------- misc

function subfolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function prop_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw Core.fail('SETUP', 'Run setup() in the Apps Script editor first.');
  return v;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
