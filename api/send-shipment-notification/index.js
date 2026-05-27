// POST /api/send-shipment-notification
// Body: { shipment: {...}, transfers: [...] }
// Called by the frontend after a shipment is created. Routes the notification:
//   - If destination = Pharmacy: email goes to that pharmacy's address (from settings.locationEmails)
//   - If destination = Patient: email goes to the FILL location (so they know it's gone out)
//
// Built into the same email pattern as the daily summary.

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

async function loadSettings() {
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  const client = TableClient.fromConnectionString(conn, 'settings');
  try { const e = await client.getEntity('global', 'main'); return JSON.parse(e.body || '{}'); }
  catch (e) { if (e.statusCode === 404) return {}; throw e; }
}

function buildPharmacyShipmentHtml(shipment, transfers) {
  const carrier = shipment.carrier || 'FedEx';
  const tracking = shipment.trackingNumber || '(no tracking)';
  const trackingUrl = carrier === 'FedEx' && tracking ? `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(tracking)}` : '#';
  const rows = transfers.map(t => `<tr>
    <td><a href="${PORTAL_URL}/?transfer=${t.id}" style="color:#2a6ebb;text-decoration:none">${t.patientName || '(unnamed)'}</a></td>
    <td>${(t.items||[]).map(i => i.drug).filter(Boolean).join(', ').slice(0,60) || '—'}</td>
    <td>${t.items.length} Rx</td>
  </tr>`).join('');
  return `<!DOCTYPE html><html><body style="font-family:'Segoe UI',sans-serif;color:#0f172a;max-width:680px;margin:0 auto;padding:18px">
    <div style="background:linear-gradient(135deg,#172a4f,#233f76);color:white;padding:18px 22px;border-radius:8px;margin-bottom:14px">
      <div style="font-weight:600;font-size:18px">📦 A transfer has been shipped to your pharmacy</div>
      <div style="opacity:.85;font-size:13px;margin-top:4px">From: ${shipment.fromLocation} · To: ${shipment.toLocation}</div>
    </div>
    <p>The following <strong>${transfers.length}</strong> transfer${transfers.length===1?'':'s'} ${transfers.length===1?'is':'are'} on the way to your pharmacy.</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin:12px 0">
      <thead><tr style="background:#f1f5f9"><th style="text-align:left;padding:6px 10px">Patient</th><th style="text-align:left;padding:6px 10px">Drug</th><th style="padding:6px 10px">Items</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="background:#cfdbed;padding:14px 18px;border-radius:6px;margin:14px 0">
      <div style="font-size:11px;text-transform:uppercase;color:#233f76;font-weight:600;letter-spacing:.04em">Tracking</div>
      <div style="font-family:'Consolas',monospace;font-size:15px;font-weight:600;margin:4px 0">${tracking}</div>
      ${shipment.bulkShipmentId ? `<div style="font-size:11px;color:#475569">Bulk shipment ID: <code>${shipment.bulkShipmentId}</code></div>` : ''}
      <div style="margin-top:10px"><a href="${PORTAL_URL}/?tab=shipments" style="background:#2a6ebb;color:white;padding:8px 14px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:600;display:inline-block">Open shipment in portal</a>
      ${tracking !== '(no tracking)' ? ` <a href="${trackingUrl}" style="background:white;color:#2a6ebb;padding:8px 14px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:600;border:1px solid #2a6ebb;display:inline-block">Track with FedEx</a>` : ''}</div>
    </div>
    <p style="font-size:11px;color:#94a3b8;margin-top:18px">Sent by PI Transfer Tracker · ${PORTAL_URL}</p>
  </body></html>`;
}

function buildPatientShipmentHtml(shipment, transfer) {
  const carrier = shipment.carrier || 'FedEx';
  const tracking = shipment.trackingNumber || '(no tracking)';
  const trackingUrl = carrier === 'FedEx' && tracking ? `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(tracking)}` : '#';
  return `<!DOCTYPE html><html><body style="font-family:'Segoe UI',sans-serif;color:#0f172a;max-width:680px;margin:0 auto;padding:18px">
    <div style="background:linear-gradient(135deg,#172a4f,#233f76);color:white;padding:18px 22px;border-radius:8px;margin-bottom:14px">
      <div style="font-weight:600;font-size:18px">📦 A transfer was shipped to your patient</div>
      <div style="opacity:.85;font-size:13px;margin-top:4px">From: ${shipment.fromLocation}</div>
    </div>
    <table style="width:100%;font-size:13px;line-height:1.8;border-collapse:collapse">
      <tr><td style="color:#64748b;width:140px">Patient:</td><td><strong>${transfer.patientName || '(unnamed)'}</strong></td></tr>
      <tr><td style="color:#64748b">Drug:</td><td>${(transfer.items||[]).map(i => i.drug).filter(Boolean).join(', ') || '—'}</td></tr>
      ${transfer.shipCity ? `<tr><td style="color:#64748b">Shipping to:</td><td>${transfer.shipAddr1 ? transfer.shipAddr1 + ', ' : ''}${transfer.shipCity}, ${transfer.shipState || ''} ${transfer.shipZip || ''}</td></tr>` : ''}
    </table>
    <div style="background:#cfdbed;padding:14px 18px;border-radius:6px;margin:14px 0">
      <div style="font-size:11px;text-transform:uppercase;color:#233f76;font-weight:600;letter-spacing:.04em">Tracking</div>
      <div style="font-family:'Consolas',monospace;font-size:15px;font-weight:600;margin:4px 0">${tracking}</div>
      <div style="margin-top:10px"><a href="${PORTAL_URL}/?transfer=${transfer.id}" style="background:#2a6ebb;color:white;padding:8px 14px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:600;display:inline-block">View transfer in portal</a>
      ${tracking !== '(no tracking)' ? ` <a href="${trackingUrl}" style="background:white;color:#2a6ebb;padding:8px 14px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:600;border:1px solid #2a6ebb;display:inline-block">Track with FedEx</a>` : ''}</div>
    </div>
    <p style="font-size:11px;color:#94a3b8;margin-top:18px">Sent by PI Transfer Tracker · ${PORTAL_URL}</p>
  </body></html>`;
}

module.exports = async function (context, req) {
  try {
    const { shipment, transfers } = req.body || {};
    if (!shipment || !transfers) { context.res = { status: 400, body: { error: 'shipment + transfers required' } }; return; }
    const settings = await loadSettings();
    const locationEmails = settings.locationEmails || DEFAULT_LOCATION_EMAILS;

    let recipients = [];
    let subject = '';
    let html = '';
    // Per-location emails can be a single string, comma-separated, or an array. Normalize.
    const toArray = v => {
      if (!v) return [];
      if (Array.isArray(v)) return v.filter(Boolean);
      return String(v).split(/[,\n;]+/).map(s => s.trim()).filter(Boolean);
    };

    if (shipment.destinationType === 'Pharmacy') {
      recipients = toArray(locationEmails[shipment.toLocation]);
      if (recipients.length === 0) {
        context.res = { status: 200, body: { skipped: true, reason: `No email configured for ${shipment.toLocation}` } };
        return;
      }
      subject = `📦 Transfer shipped to ${shipment.toLocation} — ${transfers.length} Rx`;
      html = buildPharmacyShipmentHtml(shipment, transfers);
    } else if (shipment.destinationType === 'Patient') {
      // Notify the FILL location (the pharmacy that sent it) so they have a record
      const t0 = transfers[0] || {};
      recipients = toArray(locationEmails[shipment.fromLocation]);
      if (recipients.length === 0) {
        context.res = { status: 200, body: { skipped: true, reason: `No email configured for ${shipment.fromLocation}` } };
        return;
      }
      subject = `📦 Transfer shipped to patient ${t0.patientName || ''} — tracking ${shipment.trackingNumber || ''}`;
      html = buildPatientShipmentHtml(shipment, t0);
    } else {
      context.res = { status: 400, body: { error: 'Unknown destination type' } };
      return;
    }
    await sendMail({ to: recipients, subject, html });
    context.res = { status: 200, body: { sent: true, recipients } };
  } catch (err) {
    context.log.error('send-shipment-notification error', err);
    context.res = { status: err.statusCode || 500, body: { error: err.message } };
  }
};

// Default per-location email addresses (overridable via settings.locationEmails)
const DEFAULT_LOCATION_EMAILS = {
  'Erie': 'erie@pharmacyinnovations.net',
  'Greenville': 'greenville@pharmacyinnovations.net',
  'Houston': 'houston@pharmacyinnovations.net',
  'Jamestown': 'jamestown@pharmacyinnovations.net',
  'Virginia Beach': 'vbeach@pharmacyinnovations.net',
  'Seminole': 'stpete@pharmacyinnovations.net'
  // Lancaster, Tucson, Flower Mound, Denton, Corinth — to be configured in Admin
};
