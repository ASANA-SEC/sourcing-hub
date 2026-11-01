/**
 * Sourcing Hub — second sending account
 *
 * A separate Apps Script project owned by the second Gmail account. It holds no data and has two files:
 *   Mail.gs  — the same file as in the main project
 *   Relay.gs — this file
 *
 * Setup (see README.md):
 *   1. Run setupRelay() once and approve the permissions. The Execution log prints the secret.
 *   2. Deploy > New deployment > Web app: Execute as "Me", access "Anyone".
 *   3. In the main project's Script Properties, add RELAY_URL (the /exec address) and RELAY_SECRET.
 *
 * Only a caller holding the secret can use it, and only for the operations listed here.
 */

const RELAY_OPS = ['status', 'createDraft', 'deleteDraft', 'sendDraft', 'sendTest', 'threadMessages', 'threadFiles', 'replyAll'];

/** Run once from the editor. Safe to run again: it keeps the existing secret. */
function setupRelay() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('RELAY_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('RELAY_SECRET', secret);
  }
  // Touching Gmail and Drive here makes Google ask for the permissions while someone is at the keyboard.
  Logger.log('Sends as: ' + Session.getEffectiveUser().getEmail() + ' (' + GmailApp.getDrafts().length + ' drafts, ' + MailApp.getRemainingDailyQuota() + ' recipients left today)');
  DriveApp.getRootFolder();
  Logger.log('RELAY_SECRET: ' + secret);
}

function doGet() {
  return relayJson_({ ok: true, app: 'sourcing-relay' });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const secret = PropertiesService.getScriptProperties().getProperty('RELAY_SECRET');
    if (!secret || req.secret !== secret) return relayJson_({ ok: false, error: 'Not allowed.' });
    if (RELAY_OPS.indexOf(req.op) < 0) return relayJson_({ ok: false, error: 'Unknown operation.' });
    return relayJson_({ ok: true, data: localMail_[req.op].apply(localMail_, req.args || []) });
  } catch (err) {
    return relayJson_({ ok: false, error: String(err.message || err) });
  }
}

function relayJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
