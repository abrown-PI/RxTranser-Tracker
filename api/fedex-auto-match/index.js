// POST /api/fedex-auto-match
// Body (optional): { dateFrom, dateTo, threshold, dryRun }
//
// Scheduled job target. Pulls recent FedEx shipments, scores each against open transfers
// without a tracking number, and AUTO-APPLIES matches that exceed the confidence threshold.
// Lower-confidence matches are returned in the response for human review (no auto-apply).
//
// Defaults:
//   dateFrom = today - 10 days
//   dateTo = today
//   threshold = 80 (score 0-100ish — see scoreMatch)
//   dryRun = false (set true to preview without writing)

const { TableClient } = require('@azure/data-tables');

// === Shared FedEx auth (same pattern as fedex-track / fedex-search) ===
let _cachedToken = null;
let _cachedTokenExpiry = 0;
async function getAccessToken() {
  if (_cachedToken && Date.now() < _cachedTokenExpiry) return _cachedToken;
  const base = process.env.FEDEX_API_BASE || 'https://apis-sandbox.fedex.com';
  const clientId = process.env.FEDEX_CLIENT_ID;
  const clientSecret = process.env.FEDEX_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw Object.assign(new Error('FedEx not configured'), { statusCode: 503 });
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
  const resp = await fetch(base + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!resp.ok) throw Object.assign(new Error('FedEx OAuth failed'), { statusCode: 502 });
  const data = await resp.json();
  _cachedToken = data.access_token;
  _cachedTokenExpiry = Date.now() + (data.expires_in - 600) * 1000;
  return _cachedToken;
}

// === Pull FedEx shipments by date range (mirrors /api/fedex-search) ===
async function pullFedexShipments(dateFrom, dateTo) {
  const base = process.env.FEDEX_API_BASE || 'https://apis-sandbox.fedex.com';
  const accountNumber = process.env.FEDEX_ACCOUNT_NUMBER || '';
  const token = await getAccessToken();
  const body = {
    accountNumber: { value: accountNumber },
    searchDateRange: { beginDate: dateFrom, endDate: dateTo },
    paging: { resultsPerPage: 250 }
  };
  const resp = await fetch(base + '/shipments/v1/searches', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'X-locale': 'en_US' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw Object.assign(new Error('FedEx search ' + resp.status), { statusCode: resp.status });
  const data = await resp.json();
  const out = data && data.output;
  const raw = (out && (out.shipments || out.shipmentDetails)) || [];
  return raw.map(s => {
    const trackingNumber = (s.trackingNumber || (s.masterTrackingNumber && s.masterTrackingNumber.trackingNumber) || '').replace(/\s+/g, '');
    const r = s.recipient || s.recipientAddress || s.receiverAddress || {};
    const contact = r.contact || s.recipientContact || {};
    const addr = r.address || r;
    return {
      trackingNumber,
      shipDate: s.shipDateStamp || s.shipDate || null,
      recipient: {
        name: contact.personName || r.personName || s.recipientName || '',
        addr1: (addr.streetLines && addr.streetLines[0]) || addr.streetLine1 || '',
        city: addr.city || '',
        state: addr.stateOrProvinceCode || addr.state || '',
        zip: addr.postalCode || addr.zip || ''
      }
    };
  }).filter(s => s.trackingNumber);
}

// === Load all transfers from Table Storage ===
async function loadTransfers() {
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  if (!conn) throw new Error('AZURE_STORAGE_CONNECTION not set');
  const client = TableClient.fromConnectionString(conn, 'transfers');
  const out = [];
  try {
    for await (const e of client.listEntities()) {
      try { out.push(JSON.parse(e.body)); } catch {}
    }
  } catch (e) { if (e.statusCode !== 404) throw e; }
  return out;
}

async function updateTransfer(t) {
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  const client = TableClient.fromConnectionString(conn, 'transfers');
  const stripDataUrls = (obj) => {
    if (!obj) return obj;
    if (Array.isArray(obj)) return obj.map(stripDataUrls);
    if (typeof obj === 'object') {
      const o = {};
      for (const k of Object.keys(obj)) { if (k === 'dataUrl') continue; o[k] = stripDataUrls(obj[k]); }
      return o;
    }
    return obj;
  };
  const cleaned = stripDataUrls(t);
  await client.upsertEntity({
    partitionKey: 'pi', rowKey: String(t.id), body: JSON.stringify(cleaned),
    patientName: t.patientName || '', status: t.status || '', originLocation: t.originLocation || '',
    fillLocation: t.fillLocation || '', createdAt: t.createdAt || new Date().toISOString(),
    transferType: t.transferType || 'New'
  }, 'Replace');
}

// === Scoring (same logic as frontend scoreMatch but server-side) ===
function normalizeAddr(s) {
  if (!s) return '';
  return String(s).toUpperCase()
    .replace(/\bSTREET\b/g, 'ST').replace(/\bROAD\b/g, 'RD').replace(/\bAVENUE\b/g, 'AVE')
    .replace(/\bDRIVE\b/g, 'DR').replace(/\bBOULEVARD\b/g, 'BLVD').replace(/\bLANE\b/g, 'LN')
    .replace(/\bCIRCLE\b/g, 'CIR').replace(/\bCOURT\b/g, 'CT').replace(/\bPLACE\b/g, 'PL')
    .replace(/[.,#]/g, '').replace(/\s+/g, ' ').trim();
}
function lastNameOf(name) { if (!name) return ''; return name.split(',')[0].trim().toUpperCase(); }
function scoreMatch(fedexShip, transfer, pharmacyAddresses) {
  let score = 0;
  const r = fedexShip.recipient || {};
  const tLast = lastNameOf(transfer.patientName);
  const fLast = lastNameOf(r.name);
  if (tLast && fLast && tLast === fLast) score += 50;
  if (transfer.shipTo === 'Pharmacy') {
    const pa = (pharmacyAddresses || {})[transfer.originLocation];
    if (pa) {
      if (normalizeAddr(pa.addr1) === normalizeAddr(r.addr1) && pa.zip && pa.zip === r.zip) score += 40;
      else if (pa.zip && pa.zip === r.zip) score += 20;
    }
  } else {
    if (transfer.shipAddr1 && r.addr1 && normalizeAddr(transfer.shipAddr1) === normalizeAddr(r.addr1)) score += 40;
    if (transfer.shipZip && r.zip && transfer.shipZip === r.zip) score += 10;
    if (transfer.shipCity && r.city && transfer.shipCity.toUpperCase() === r.city.toUpperCase()) score += 5;
  }
  const fDate = fedexShip.shipDate ? new Date(fedexShip.shipDate) : null;
  const tDate = transfer.createdAt ? new Date(transfer.createdAt) : null;
  if (fDate && tDate) {
    const daysOff = Math.abs(fDate - tDate) / 86400000;
    const window = transfer.shipTo === 'Pharmacy' ? 3 : 10;
    if (daysOff <= window) score += Math.max(0, 10 - daysOff);
  }
  return score;
}

// Hardcoded pharmacy addresses (matches frontend; eventually load from /api/settings)
const PHARMACY_ADDRESSES = {
  'Erie':           { addr1: '2936 W. 17th Street', city: 'Erie', state: 'PA', zip: '16505' },
  'Lancaster':      { addr1: '902 N. Duke Street', city: 'Lancaster', state: 'PA', zip: '17602' },
  'Greenville':     { addr1: '640 Congaree Rd', city: 'Greenville', state: 'SC', zip: '29607' },
  'Houston':        { addr1: '8687 Louetta Rd', city: 'Spring', state: 'TX', zip: '77379' },
  'Tucson':         { addr1: '2729 E Speedway Blvd', city: 'Tucson', state: 'AZ', zip: '85716' },
  'Jamestown':      { addr1: '863 Fairmount Ave', city: 'Jamestown', state: 'NY', zip: '14701' },
  'Virginia Beach': { addr1: '3636 Virginia Beach Blvd', city: 'Virginia Beach', state: 'VA', zip: '23452' },
  'Seminole':       { addr1: '7779 Starkey Rd', city: 'Seminole', state: 'FL', zip: '33777' }
};

module.exports = async function (context, req) {
  try {
    const body = req.body || {};
    const today = new Date().toISOString().slice(0, 10);
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const dateFrom = body.dateFrom || tenDaysAgo;
    const dateTo = body.dateTo || today;
    const threshold = body.threshold || 80;
    const dryRun = !!body.dryRun;

    context.log(`Auto-match starting: ${dateFrom} → ${dateTo}, threshold ${threshold}, dryRun=${dryRun}`);

    const [shipments, transfers] = await Promise.all([pullFedexShipments(dateFrom, dateTo), loadTransfers()]);
    const openTransfers = transfers.filter(t => !['Delivered', 'Canceled'].includes(t.status) && !t.trackingNumber);

    context.log(`Pulled ${shipments.length} FedEx shipments, ${openTransfers.length} open transfers without tracking`);

    const applied = [];
    const needsReview = [];
    for (const s of shipments) {
      const candidates = openTransfers
        .map(t => ({ transfer: t, score: scoreMatch(s, t, PHARMACY_ADDRESSES) }))
        .filter(c => c.score > 0)
        .sort((a, b) => b.score - a.score);
      const best = candidates[0];
      if (!best) continue;
      if (best.score >= threshold) {
        if (!dryRun) {
          best.transfer.trackingNumber = s.trackingNumber;
          best.transfer.dateShipped = s.shipDate || best.transfer.dateShipped || today;
          if (!['Shipped', 'Delivered', 'Canceled'].includes(best.transfer.status)) {
            best.transfer.status = 'Shipped';
          }
          best.transfer.fedexAutoMatched = true;
          best.transfer.fedexAutoMatchedAt = new Date().toISOString();
          await updateTransfer(best.transfer);
        }
        applied.push({
          trackingNumber: s.trackingNumber, score: best.score,
          transferId: best.transfer.id, patientName: best.transfer.patientName
        });
      } else if (best.score >= 40) {
        needsReview.push({
          trackingNumber: s.trackingNumber, score: best.score,
          transferId: best.transfer.id, patientName: best.transfer.patientName,
          recipient: s.recipient
        });
      }
    }

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        dateRange: { from: dateFrom, to: dateTo },
        threshold,
        dryRun,
        pulledShipments: shipments.length,
        openTransfers: openTransfers.length,
        autoApplied: applied,
        needsReview
      }
    };
  } catch (err) {
    context.log.error('auto-match error', err);
    context.res = { status: err.statusCode || 500, body: { error: err.message } };
  }
};
