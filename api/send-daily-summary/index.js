// POST /api/send-daily-summary
// Body (optional): { recipients: [...], dryRun: true }
//
// Builds an end-of-day summary email per-location showing how many transfers were received
// today, grouped by origin location, with current status. Sends via Microsoft Graph to the
// configured recipient list (or any override passed in).
//
// Scheduled by GitHub Actions cron at 5 PM ET daily.

const { TableClient } = require('@azure/data-tables');

const PORTAL_URL = 'https://red-island-0bb34e510.7.azurestaticapps.net';

// --- Mail helper (inlined to avoid cross-folder require issues in Azure SWA) ---
let _tok = null, _tokExp = 0;
async function getGraphToken() {
  if (_tok && Date.now() < _tokExp) return _tok;
  const t = process.env.AZURE_AD_TENANT_ID, c = process.env.AZURE_AD_CLIENT_ID, s = process.env.AZURE_AD_CLIENT_SECRET;
  if (!t || !c || !s) throw Object.assign(new Error('Graph mail not configured'), { statusCode: 503 });
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: c, client_secret: s, scope: 'https://graph.microsoft.com/.default' });
  const r = await fetch(`https://login.microsoftonline.com/${t}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString()
  });
  if (!r.ok) throw Object.assign(new Error('Graph token ' + r.status), { statusCode: 502 });
  const d = await r.json();
  _tok = d.access_token;
  _tokExp = Date.now() + (d.expires_in - 60) * 1000;
  return _tok;
}
async function sendMail({ to, subject, html }) {
  const sender = process.env.MAIL_SENDER;
  if (!sender) throw new Error('MAIL_SENDER not set');
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) throw new Error('No recipients');
  const token = await getGraphToken();
  const msg = {
    subject, body: { contentType: 'HTML', content: html },
    toRecipients: recipients.map(a => ({ emailAddress: { address: a } }))
  };
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`, {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg, saveToSentItems: false })
  });
  if (r.status !== 202) { const t = await r.text(); throw new Error('sendMail ' + r.status + ' ' + t.slice(0, 300)); }
  return true;
}

// --- Load all transfers + settings from Table Storage ---
async function loadTransfers() {
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  const client = TableClient.fromConnectionString(conn, 'transfers');
  const out = [];
  try { for await (const e of client.listEntities()) { try { out.push(JSON.parse(e.body)); } catch {} } }
  catch (e) { if (e.statusCode !== 404) throw e; }
  return out;
}
async function loadSettings() {
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  const client = TableClient.fromConnectionString(conn, 'settings');
  try { const e = await client.getEntity('global', 'main'); return JSON.parse(e.body || '{}'); }
  catch (e) { if (e.statusCode === 404) return {}; throw e; }
}

function buildSummaryHtml(transfers, dateStr) {
  const byOrigin = {};
  transfers.forEach(t => {
    const k = t.originLocation || 'Unknown';
    if (!byOrigin[k]) byOrigin[k] = [];
    byOrigin[k].push(t);
  });
  const total = transfers.length;
  const sections = Object.keys(byOrigin).sort().map(loc => {
    const rows = byOrigin[loc].map(t => `<tr>
      <td><a href="${PORTAL_URL}/?transfer=${t.id}" style="color:#2a6ebb;text-decoration:none">${t.patientName || '(unnamed)'}</a></td>
      <td>${(t.items||[]).map(i => i.drug).filter(Boolean).join(', ').slice(0,60) || '—'}</td>
      <td><span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:#dbeafe;color:#1e40af;font-weight:600">${t.status||'—'}</span></td>
      <td><a href="${PORTAL_URL}/?transfer=${t.id}" style="color:#2a6ebb;font-size:11px">Open →</a></td>
    </tr>`).join('');
    return `<h3 style="color:#233f76;margin:18px 0 6px;border-bottom:1px solid #cbd5e1;padding-bottom:4px">From ${loc} (${byOrigin[loc].length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f1f5f9"><th style="text-align:left;padding:6px 10px">Patient</th><th style="text-align:left;padding:6px 10px">Drug</th><th style="text-align:left;padding:6px 10px">Status</th><th style="padding:6px 10px"></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }).join('');
  return `<!DOCTYPE html><html><body style="font-family:'Segoe UI',sans-serif;color:#0f172a;max-width:720px;margin:0 auto;padding:18px">
    <div style="background:linear-gradient(135deg,#172a4f,#233f76);color:white;padding:18px 22px;border-radius:8px;margin-bottom:14px">
      <div style="font-weight:600;font-size:18px">Pharmacy Innovations · Daily Transfer Summary</div>
      <div style="opacity:.85;font-size:13px;margin-top:4px">${dateStr} · ${total} transfer${total===1?'':'s'} today</div>
    </div>
    ${total === 0 ? '<p style="color:#64748b">No transfer activity today.</p>' : sections}
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
    <p style="font-size:12px;color:#64748b">Need to change recipients? <a href="${PORTAL_URL}/?tab=admin" style="color:#2a6ebb">Sign in to the portal</a> → Admin → Email Notifications</p>
    <p style="font-size:11px;color:#94a3b8">Sent by PI Transfer Tracker · ${PORTAL_URL}</p>
  </body></html>`;
}

module.exports = async function (context, req) {
  try {
    const body = req.body || {};
    const dryRun = !!body.dryRun;
    const settings = await loadSettings();
    const recipients = body.recipients || settings.dailySummaryRecipients || ['erie@pharmacyinnovations.net', 'alincoln@pharmacyinnovations.net'];

    // Today's transfers (created today by createdAt) — Eastern Time approximation
    const allTransfers = await loadTransfers();
    const today = new Date();
    const todayStr = today.toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'short', day: 'numeric' });
    const ymd = today.toISOString().slice(0, 10);
    const todaysTransfers = allTransfers.filter(t => (t.createdAt || '').slice(0, 10) === ymd);

    const html = buildSummaryHtml(todaysTransfers, todayStr);
    const subject = `PI Transfer Summary — ${todayStr} (${todaysTransfers.length} transfer${todaysTransfers.length===1?'':'s'})`;

    if (dryRun) {
      context.res = { status: 200, body: { dryRun: true, recipients, transferCount: todaysTransfers.length, htmlPreview: html.slice(0, 2000) } };
      return;
    }
    await sendMail({ to: recipients, subject, html });
    context.res = { status: 200, body: { sent: true, recipients, transferCount: todaysTransfers.length } };
  } catch (err) {
    context.log.error('send-daily-summary error', err);
    context.res = { status: err.statusCode || 500, body: { error: err.message } };
  }
};
