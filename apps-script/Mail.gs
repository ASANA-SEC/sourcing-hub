/**
 * Sourcing Hub — everything that touches Gmail. The same file goes into the main project and the
 * second account's relay project, so both accounts behave alike.
 */

const localMail_ = {
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
  threadFiles: function (threadId, ours) {
    const out = { files: [], skipped: [], text: '' };
    GmailApp.getThreadById(threadId).getMessages().forEach(function (m) {
      const from = m.getFrom().toLowerCase();
      if (ours.some(function (o) { return from.indexOf(o) >= 0; })) return;
      out.text += '\n\n--- Email from ' + m.getFrom() + ' ---\n' + m.getPlainBody().slice(0, 20000);
      m.getAttachments().forEach(function (a) {
        const name = a.getName();
        const size = a.getSize();
        if (/\.(png|jpe?g|gif)$/i.test(name) && size < 100000) return; // signature logos
        if (size > 20 * 1024 * 1024) { out.skipped.push(name); return; }
        const read = attachmentForReading_(a);
        if (read) out.files.push(read); else out.skipped.push(name);
      });
    });
    return out;
  },
  threadMessages: function (threadId) {
    return GmailApp.getThreadById(threadId).getMessages().map(function (m) {
      let auto = '';
      try { auto = m.getHeader('Auto-Submitted'); } catch (e) { auto = ''; }
      return {
        time: m.getDate().getTime(), from: m.getFrom(), subject: m.getSubject(), snippet: m.getPlainBody().slice(0, 500),
        attachments: m.getAttachments().map(function (a) { return a.getName(); }), isAuto: !!auto && auto.toLowerCase() !== 'no',
      };
    });
  },
  replyAll: function (threadId, body) {
    const msgs = GmailApp.getThreadById(threadId).getMessages();
    msgs[msgs.length - 1].replyAll(body, mailOptions_({ body: body }));
  },
  notify: function (to, subject, body, html) { GmailApp.sendEmail(to, subject, body, html ? { htmlBody: html } : {}); },
};

/** Plain text and an HTML copy with the same line breaks, so Gmail does not re-wrap item lists. */
function mailOptions_(m) {
  const html = String(m.body).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  const options = { htmlBody: '<div style="font-family:Arial,sans-serif;font-size:14px">' + html + '</div>' };
  if (m.cc) options.cc = m.cc.split('; ').join(',');
  if (m.fileIds && m.fileIds.length) options.attachments = m.fileIds.map(function (id) { return DriveApp.getFileById(id).getBlob(); });
  if (m.attachments && m.attachments.length) options.attachments = m.attachments.map(function (f) { return Utilities.newBlob(Utilities.base64Decode(f.base64), f.mime, f.name); });
  return options;
}

// ---------------------------------------------------------------- quotation files

/** PDFs and pictures go as they are; Excel, Word and CSV are unpacked to text; anything else needs a person. */
function attachmentForReading_(a) {
  const name = a.getName();
  const ext = (/\.([^.]+)$/.exec(name) || [])[1];
  const type = String(ext || '').toLowerCase();
  if (type === 'pdf') return { name: name, kind: 'pdf', base64: Utilities.base64Encode(a.getBytes()) };
  if (type === 'png' || type === 'jpg' || type === 'jpeg' || type === 'gif') return { name: name, kind: 'image', mime: type === 'jpg' ? 'image/jpeg' : 'image/' + type, base64: Utilities.base64Encode(a.getBytes()) };
  if (type === 'csv' || type === 'txt') return { name: name, kind: 'text', text: a.getDataAsString() };
  if (type === 'xlsx') return { name: name, kind: 'text', text: xlsxText_(a) };
  if (type === 'docx') return { name: name, kind: 'text', text: docxText_(a) };
  return null;
}

function zipParts_(blob) {
  const parts = {};
  Utilities.unzip(blob.copyBlob().setContentType('application/zip')).forEach(function (b) { parts[b.getName()] = b; });
  return parts;
}

function xmlDecode_(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function docxText_(blob) {
  const doc = zipParts_(blob)['word/document.xml'];
  if (!doc) throw new Error('Could not open ' + blob.getName());
  return xmlDecode_(doc.getDataAsString().replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, ' | ').replace(/<[^>]+>/g, ''));
}

/** Every sheet as tab-separated rows. */
function xlsxText_(blob) {
  const parts = zipParts_(blob);
  const shared = [];
  if (parts['xl/sharedStrings.xml']) {
    (parts['xl/sharedStrings.xml'].getDataAsString().match(/<si>[\s\S]*?<\/si>/g) || []).forEach(function (si) {
      shared.push(xmlDecode_((si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map(function (t) { return t.replace(/<[^>]+>/g, ''); }).join('')));
    });
  }
  let out = '';
  Object.keys(parts).filter(function (n) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(n); }).sort().forEach(function (n) {
    out += '\n--- ' + n.replace(/^.*\//, '') + ' ---\n';
    (parts[n].getDataAsString().match(/<row[\s\S]*?<\/row>/g) || []).forEach(function (row) {
      const cells = (row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []).map(function (c) {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(c) || [])[1];
        const inline = (/<t[^>]*>([\s\S]*?)<\/t>/.exec(c) || [])[1];
        if (/t="s"/.test(c) && v !== undefined) return shared[Number(v)] || '';
        return xmlDecode_(v !== undefined ? v : (inline || ''));
      });
      out += cells.join('\t') + '\n';
    });
  });
  return out;
}
