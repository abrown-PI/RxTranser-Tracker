// POST /api/fedex-auto-match
// Body (optional): { dryRun }
//
// Scheduled daily job. For every open transfer without a tracking number,
// queries FedEx Track API by the transfer's reference (transfer ID).
// If FedEx returns a shipment, the tracking # + ship date are linked to the
// transfer automatically. This requires staff to enter the transfer ID into
// WorldShip's "Customer Reference" field when generating the label.

const { TableClient } = require('@azure/data-tables');

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

async function loadShipments() {
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  if (!conn) return [];
  // Shipments live in 'shipments' table if we've started persisting them; if not, return empty
  try {
    const client = TableClient.fromConnectionString(conn, 'shipments');
    const out = [];
    for await (const e of client.listEntities()) {
      try { out.push(JSON.parse(e.body)); } catch {}
    }
    return out;
  } catch (e) { if (e.statusCode === 404) return []; throw e; }
}

async function updateShipment(s) {
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  if (!conn) return;
  const client = TableClient.fromConnectionString(conn, 'shipments');
  try { await client.createTable(); } catch (e) { if (e.statusCode !== 409) throw e; }
  await client.upsertEntity({
    partitionKey: 'pi', rowKey: String(s.id),
    body: JSON.stringify(s),
    trackingNumber: s.trackingNumber || '', bulkShipmentId: s.bulkShipmentId || '',
    status: s.status || ''
  }, 'Replace');
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

// Query FedEx Track API for a batch of references. Returns map: reference -> { trackingNumber, shipDate }
async function searchByReferences(refs, context) {
  const base = process.env.FEDEX_API_BASE || 'https://apis-sandbox.fedex.com';
  const accountNumber = process.env.FEDEX_ACCOUNT_NUMBER || '';
  const token = await getAccessToken();
  const today = new Date();
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000);
  const fmtDate = d => d.toISOString().slice(0, 10);
  const found = {};
  for (let i = 0; i < refs.length; i += 30) {
    const chunk = refs.slice(i, i + 30);
    const body = {
      includeDetailedScans: false,
      trackingInfo: chunk.map(r => ({
        trackingNumberInfo: {
          trackingNumber: String(r),
          trackingNumberType: 'FEDEX_REFERENCE_NUMBER',
          carrierCode: 'FDXE'
        },
        shipmentAccountNumber: { value: accountNumber },
        shipDateBegin: fmtDate(ninetyDaysAgo),
        shipDateEnd: fmtDate(today)
      }))
    };
    const resp = await fetch(base + '/track/v1/trackingnumbers', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'X-locale': 'en_US' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const txt = await resp.text();
      context.log.warn(`FedEx track-by-ref chunk failed: ${resp.status} ${txt.slice(0, 200)}`);
      continue;
    }
    const data = await resp.json();
    const out = data && data.output;
    if (!out || !Array.isArray(out.completeTrackResults)) continue;
    out.completeTrackResults.forEach((r, idx) => {
      const reference = chunk[idx];
      const first = (r.trackResults || [])[0] || {};
      const trackingNumber = (r.trackingNumber || (first.trackingNumberInfo && first.trackingNumberInfo.trackingNumber) || '').replace(/\s+/g, '');
      if (!trackingNumber) return;
      const dates = first.dateAndTimes || [];
      const shipDate = (dates.find(d => d.type === 'ACTUAL_PICKUP') || dates.find(d => d.type === 'SHIP') || {}).dateTime || null;
      found[reference] = {
        trackingNumber,
        shipDate: shipDate ? String(shipDate).slice(0, 10) : null
      };
    });
  }
  return found;
}

module.exports = async function (context, req) {
  try {
    const body = req.body || {};
    const dryRun = !!body.dryRun;
    const today = new Date().toISOString().slice(0, 10);

    const transfers = await loadTransfers();
    const openTransfers = transfers.filter(t => !['Delivered', 'Canceled'].includes(t.status) && !t.trackingNumber);

    // Also load shipments — for bulk pharmacy shipments, the BULK-* shipment ID is the
    // FedEx reference (not the transfer ID), so we query by that and apply the tracking
    // to every transfer in the bulk.
    const shipments = await loadShipments();
    const openBulkShipments = shipments.filter(s => s.bulkShipmentId && !s.trackingNumber && s.status !== 'Received');

    if (openTransfers.length === 0 && openBulkShipments.length === 0) {
      context.res = { status: 200, body: { applied: 0, message: 'No open transfers or bulk shipments without tracking' } };
      return;
    }

    // Build the combined reference list. Transfers use their numeric ID, bulks use their BULK-* ID.
    const transferRefs = openTransfers.map(t => String(t.id));
    const shipmentRefs = openBulkShipments.map(s => s.bulkShipmentId);
    const allRefs = [...transferRefs, ...shipmentRefs];
    context.log(`Auto-match querying FedEx for ${allRefs.length} references (${transferRefs.length} transfers + ${shipmentRefs.length} bulk shipments)…`);

    const found = await searchByReferences(allRefs, context);
    const applied = [];

    // First: handle bulk shipments. Any match applies the tracking to ALL transfers in the bulk.
    for (const s of openBulkShipments) {
      const match = found[s.bulkShipmentId];
      if (!match) continue;
      if (!dryRun) {
        s.trackingNumber = match.trackingNumber;
        if (match.shipDate) s.shipDate = match.shipDate;
        if (!s.status || s.status === 'Pending') s.status = 'In Transit';
        await updateShipment(s);
        // Cascade tracking to every transfer in this bulk
        for (const tid of (s.transferIds || [])) {
          const t = transfers.find(x => x.id === tid);
          if (!t) continue;
          t.trackingNumber = match.trackingNumber;
          if (match.shipDate) t.dateShipped = match.shipDate;
          if (!['Shipped', 'Delivered', 'Canceled'].includes(t.status)) t.status = 'Shipped';
          t.fedexAutoMatched = true;
          t.fedexAutoMatchedAt = new Date().toISOString();
          await updateTransfer(t);
        }
      }
      applied.push({ kind: 'bulk', bulkShipmentId: s.bulkShipmentId, trackingNumber: match.trackingNumber, transfersUpdated: (s.transferIds || []).length });
    }

    // Then: handle individual transfers (non-bulk, ship-to-patient typically)
    for (const t of openTransfers) {
      if (t.trackingNumber) continue; // may have been set by a bulk cascade above
      const ref = String(t.id);
      const match = found[ref];
      if (!match) continue;
      if (!dryRun) {
        t.trackingNumber = match.trackingNumber;
        if (match.shipDate) t.dateShipped = match.shipDate;
        else if (!t.dateShipped) t.dateShipped = today;
        if (!['Shipped', 'Delivered', 'Canceled'].includes(t.status)) t.status = 'Shipped';
        t.fedexAutoMatched = true;
        t.fedexAutoMatchedAt = new Date().toISOString();
        await updateTransfer(t);
      }
      applied.push({ kind: 'transfer', transferId: t.id, patientName: t.patientName, trackingNumber: match.trackingNumber, shipDate: match.shipDate });
    }

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        dryRun,
        openTransfers: openTransfers.length,
        referencesQueried: references.length,
        autoApplied: applied
      }
    };
  } catch (err) {
    context.log.error('auto-match error', err);
    context.res = { status: err.statusCode || 500, body: { error: err.message } };
  }
};
