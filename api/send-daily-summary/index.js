// POST /api/send-daily-summary
// Body (optional): { dryRun: true, onlyLocation: "Erie" }
//
// For each location with transfer activity today, sends a customized summary email to
// THAT location's notification recipient list. Skips locations with zero activity.
//
// Scheduled by GitHub Actions cron at 5 PM ET daily.

const { TableClient } = require('@azure/data-tables');
const PORTAL_URL = 'https://red-island-0bb34e510.7.azurestaticapps.net';

// --- Mail helper (inlined) ---
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

// Per-location email recipients can be stored as a string (legacy, single email),
// a comma-separated string, or an array. Normalize to an array.
function normalizeEmails(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value).split(/[,\n;]+/).map(s => s.trim()).filter(Boolean);
}

function statusBadge(status) {
  const c = {
    'New': '#0891b2', 'In Progress': '#d97706', 'Ready to Ship': '#92400e',
    'Shipped': '#16a34a', 'Delivered': '#1e40af', 'Canceled': '#64748b'
  }[status] || '#475569';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:${c}22;color:${c};font-weight:600">${status||'—'}</span>`;
}

function buildLocationSummaryHtml(locationName, todaysTransfers, dateStr) {
  // Two sections: transfers WE FILLED today (incoming) and transfers WE ORIGINATED today (outgoing).
  const incoming = todaysTransfers.filter(t => t.fillLocation === locationName);
  const outgoing = todaysTransfers.filter(t => t.originLocation === locationName && t.fillLocation !== locationName);
  const incomingByOrigin = {};
  incoming.forEach(t => {
    const k = t.originLocation || 'Unknown';
    (incomingByOrigin[k] = incomingByOrigin[k] || []).push(t);
  });

  const incomingSection = Object.keys(incomingByOrigin).sort().map(loc => {
    const rows = incomingByOrigin[loc].map(t => `<tr>
      <td style="padding:6px 10px"><a href="${PORTAL_URL}/?transfer=${t.id}" style="color:#2a6ebb;text-decoration:none">${t.patientName || '(unnamed)'}</a></td>
      <td style="padding:6px 10px">${(t.items||[]).map(i => i.drug).filter(Boolean).join(', ').slice(0,60) || '—'}</td>
      <td style="padding:6px 10px">${statusBadge(t.status)}</td>
      <td style="padding:6px 10px"><a href="${PORTAL_URL}/?transfer=${t.id}" style="color:#2a6ebb;font-size:11px">Open →</a></td>
    </tr>`).join('');
    return `<h3 style="color:#233f76;margin:18px 0 6px;border-bottom:1px solid #cbd5e1;padding-bottom:4px;font-size:15px">From ${loc} (${incomingByOrigin[loc].length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f1f5f9"><th style="text-align:left;padding:6px 10px">Patient</th><th style="text-align:left;padding:6px 10px">Drug</th><th style="text-align:left;padding:6px 10px">Status</th><th style="padding:6px 10px"></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }).join('');

  const outgoingRows = outgoing.map(t => `<tr>
    <td style="padding:6px 10px"><a href="${PORTAL_URL}/?transfer=${t.id}" style="color:#2a6ebb;text-decoration:none">${t.patientName || '(unnamed)'}</a></td>
    <td style="padding:6px 10px">${t.fillLocation || '—'}</td>
    <td style="padding:6px 10px">${(t.items||[]).map(i => i.drug).filter(Boolean).join(', ').slice(0,60) || '—'}</td>
    <td style="padding:6px 10px">${statusBadge(t.status)}</td>
  </tr>`).join('');
  const outgoingSection = outgoing.length === 0 ? '' : `<h2 style="color:#233f76;margin:24px 0 8px;font-size:16px">Transfers you originated today (${outgoing.length})</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f1f5f9"><th style="text-align:left;padding:6px 10px">Patient</th><th style="text-align:left;padding:6px 10px">Sent to</th><th style="text-align:left;padding:6px 10px">Drug</th><th style="text-align:left;padding:6px 10px">Status</th></tr></thead>
      <tbody>${outgoingRows}</tbody>
    </table>`;

  return `<!DOCTYPE html><html><body style="font-family:'Segoe UI',sans-serif;color:#0f172a;max-width:720px;margin:0 auto;padding:18px">
    <div style="background:linear-gradient(135deg,#172a4f,#233f76);color:white;padding:18px 22px;border-radius:8px;margin-bottom:14px">
      <div style="font-weight:600;font-size:18px">Daily Transfer Summary — ${locationName}</div>
      <div style="opacity:.85;font-size:13px;margin-top:4px">${dateStr} · ${incoming.length} received · ${outgoing.length} originated</div>
    </div>
    ${incoming.length > 0 ? `<h2 style="color:#233f76;margin:6px 0 8px;font-size:16px">Transfers you received today (${incoming.length})</h2>${incomingSection}` : ''}
    ${outgoingSection}
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
    <p style="font-size:12px;color:#64748b">Need to change recipients? Sign in to the portal → Admin → Email Notifications</p>
    <p style="font-size:11px;color:#94a3b8">Sent by PI Transfer Tracker · ${PORTAL_URL}</p>
  </body></html>`;
}

module.exports = async function (context, req) {
  try {
    const body = req.body || {};
    const dryRun = !!body.dryRun;
    const onlyLocation = body.onlyLocation || null;
    const settings = await loadSettings();
    const locationEmails = settings.locationEmails || {};
    const alwaysCc = Array.isArray(settings.dailySummaryRecipients) ? settings.dailySummaryRecipients : [];

    const allTransfers = await loadTransfers();
    const today = new Date();
    const todayStr = today.toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'short', day: 'numeric' });
    const ymd = today.toISOString().slice(0, 10);
    const todaysTransfers = allTransfers.filter(t => (t.createdAt || '').slice(0, 10) === ymd);

    // Figure out which locations have activity today
    const locationsWithActivity = new Set();
    todaysTransfers.forEach(t => {
      if (t.fillLocation) locationsWithActivity.add(t.fillLocation);
      if (t.originLocation) locationsWithActivity.add(t.originLocation);
    });

    const sent = [];
    const skipped = [];
    for (const loc of locationsWithActivity) {
      if (onlyLocation && loc !== onlyLocation) continue;
      const recipients = normalizeEmails(locationEmails[loc]);
      // Build the per-location email
      const html = buildLocationSummaryHtml(loc, todaysTransfers, todayStr);
      const involved = todaysTransfers.filter(t => t.fillLocation === loc || t.originLocation === loc);
      if (involved.length === 0) { skipped.push({ location: loc, reason: 'no transfers involved' }); continue; }
      const allRecipients = [...new Set([...recipients, ...alwaysCc])];
      if (allRecipients.length === 0) { skipped.push({ location: loc, reason: 'no recipients configured' }); continue; }
      const subject = `Daily Transfer Summary — ${loc} · ${todayStr}`;
      if (dryRun) {
        sent.push({ location: loc, recipients: allRecipients, transferCount: involved.length, dryRun: true });
        continue;
      }
      try {
        await sendMail({ to: allRecipients, subject, html });
        sent.push({ location: loc, recipients: allRecipients, transferCount: involved.length });
      } catch (e) {
        skipped.push({ location: loc, reason: 'send failed: ' + e.message });
      }
    }

    context.res = {
      status: 200,
      body: {
        date: todayStr,
        locationsWithActivity: [...locationsWithActivity],
        sent,
        skipped
      }
    };
  } catch (err) {
    context.log.error('send-daily-summary error', err);
    context.res = { status: err.statusCode || 500, body: { error: err.message } };
  }
};
