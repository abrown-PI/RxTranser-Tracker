// /api/healnow-webhook — receives HealNow prescription events and updates matching transfers.
//
// HealNow events we subscribe to (configured in pharmacy.healnow.io → Developer → Webhooks):
//   prescription::pending  → patient has been emailed a payment link (cart created)
//   prescription::paid     → patient (or staff via MOTO) has paid
//   prescription::canceled → HealNow-side cancellation
//   prescription::removed  → Rx removed from cart before payment
//
// Matching: we find the transfer whose items[].receivingRxNumber matches the Rx number on the event.
// Per Ashley: receivingRxNumber is the same value the PMS (PK) pushes to HealNow.
//
// Receipt fetch (on `paid` only): we call HealNow's GET /v1/orders/{order_id}/receipt to pull
// the PDF, upload it to our blob storage, and store the blob URL on the transfer item.
//
// Auth: webhook signature verification using the secret HealNow generates per-webhook.
// HealNow's signature algorithm isn't documented in their public docs — we accept their
// "x-healnow-signature" header and verify HMAC-SHA256 of the raw body against HEALNOW_WEBHOOK_SECRET.
// (If they use a different scheme we'll log "signature mismatch" and adjust.)

const { TableClient } = require('@azure/data-tables');
const { BlobServiceClient } = require('@azure/storage-blob');
const crypto = require('crypto');

const TRANSFERS_TABLE = 'transfers';
const AUDIT_TABLE = 'audit';
const BLOB_CONTAINER = 'documents';
const PARTITION = 'pi';

let _transferTable = null;
function getTransferTable() {
  if (_transferTable) return _transferTable;
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  if (!conn) throw Object.assign(new Error('AZURE_STORAGE_CONNECTION not set'), { statusCode: 503 });
  _transferTable = TableClient.fromConnectionString(conn, TRANSFERS_TABLE);
  return _transferTable;
}

let _blobContainer = null;
function getBlobContainer() {
  if (_blobContainer) return _blobContainer;
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  if (!conn) throw Object.assign(new Error('AZURE_STORAGE_CONNECTION not set'), { statusCode: 503 });
  const service = BlobServiceClient.fromConnectionString(conn);
  _blobContainer = service.getContainerClient(BLOB_CONTAINER);
  return _blobContainer;
}

function fromEntity(e) {
  try { return JSON.parse(e.body); } catch { return null; }
}

// Strip dataUrls before saving (Azure Table Storage 1MB row limit; binary lives in blob storage).
function stripDataUrls(obj) {
  if (!obj) return obj;
  if (Array.isArray(obj)) return obj.map(stripDataUrls);
  if (typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) {
      if (k === 'dataUrl') continue;
      out[k] = stripDataUrls(obj[k]);
    }
    return out;
  }
  return obj;
}

function toEntity(t) {
  const cleaned = stripDataUrls(t);
  return {
    partitionKey: PARTITION,
    rowKey: String(t.id),
    body: JSON.stringify(cleaned),
    patientName: t.patientName || '',
    status: t.status || '',
    originLocation: t.originLocation || '',
    fillLocation: t.fillLocation || '',
    createdAt: t.createdAt || new Date().toISOString(),
    transferType: t.transferType || 'New'
  };
}

async function listTransfers(context) {
  const table = getTransferTable();
  const out = [];
  for await (const e of table.listEntities()) {
    const t = fromEntity(e);
    if (t) out.push(t);
  }
  return out;
}

async function saveTransfer(t) {
  const table = getTransferTable();
  await table.upsertEntity(toEntity(t), 'Replace');
}

// Verify HMAC-SHA256 signature against the raw request body.
function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret) return true; // dev mode — accept anything
  if (!signatureHeader) return false;
  // HealNow's exact format isn't documented; common scheme is just the hex digest.
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  // Accept either bare hex or "sha256=<hex>" prefix.
  const given = String(signatureHeader).replace(/^sha256=/i, '').trim();
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex'));
  } catch { return false; }
}

// Extract a Rx number from an arbitrary HealNow event payload — tries the common spots.
function extractRxNumber(event) {
  const d = event && event.data;
  if (!d) return null;
  return String(
    d.rx_number || d.rxNumber || d.prescription_number ||
    (d.prescription && (d.prescription.rx_number || d.prescription.rxNumber)) ||
    d.eid || ''
  ).replace(/\s+/g, '').trim() || null;
}

function extractOrderId(event) {
  const d = event && event.data;
  if (!d) return null;
  return d.order_id || d.orderId || d.order || null;
}

function extractAmountCents(event) {
  const d = event && event.data;
  if (!d) return null;
  return d.amount_in_cents || d.amount || (d.payment && d.payment.amount_in_cents) || null;
}

// Normalize names so "BOLAND, CARISSA", "Boland Carissa", "carissa boland" all compare equal.
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[,\.]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

function extractPatientName(event) {
  const d = event && event.data;
  if (!d) return '';
  const p = d.patient || d.customer || {};
  // Try the most common shapes from HealNow / common payment APIs
  return p.full_name || p.name ||
    [p.first_name || p.firstName, p.last_name || p.lastName].filter(Boolean).join(' ') ||
    d.patient_name || '';
}

function extractEventDate(event) {
  const d = event && event.data;
  if (!d) return new Date();
  const iso = event.created_at || event.createdAt || d.created_at || d.createdAt || d.paid_at;
  return iso ? new Date(iso) : new Date();
}

// Find the transfer + item by Rx number first; fall back to patient name + recent date window
// when receivingRxNumber wasn't entered in the portal.
function findItemForEvent(transfers, event, context) {
  const rxNumber = extractRxNumber(event);
  const rxTarget = String(rxNumber || '').replace(/\s+/g, '').trim();

  // 1) Primary: match by receivingRxNumber
  if (rxTarget) {
    for (const t of transfers) {
      for (const item of (t.items || [])) {
        const candidate = String(item.receivingRxNumber || '').replace(/\s+/g, '').trim();
        if (candidate && candidate === rxTarget) return { transfer: t, item, matchedBy: 'receivingRx' };
      }
    }
    // 2) Fallback A: match by origin Rx (in case the PMS only knows the original)
    for (const t of transfers) {
      for (const item of (t.items || [])) {
        const candidate = String(item.rxNumber || '').replace(/\s+/g, '').trim();
        if (candidate && candidate === rxTarget) return { transfer: t, item, matchedBy: 'originRx' };
      }
    }
  }

  // 3) Fallback B: patient name + 7-day window of active transfers (most patients fill monthly,
  // so a wider window risks matching last month's transfer by mistake). Used when staff forgot
  // to enter receivingRxNumber. Picks the single best candidate; bails if ambiguous.
  const eventName = normName(extractPatientName(event));
  if (!eventName) return null;

  const eventDate = extractEventDate(event);
  const windowMs = 7 * 86400000;
  const candidates = transfers.filter(t => {
    if (!t.patientName || normName(t.patientName) !== eventName) return false;
    if (['Canceled'].includes(t.status)) return false;
    const created = t.createdAt ? new Date(t.createdAt) : null;
    if (!created) return false;
    const delta = Math.abs(eventDate - created);
    return delta <= windowMs;
  });
  if (candidates.length === 0) return null;
  // If only one transfer for this patient in the window, use its first unpaid item.
  if (candidates.length === 1) {
    const t = candidates[0];
    const item = (t.items || []).find(i => i.paidStatus !== 'paid') || (t.items || [])[0];
    if (item) {
      context.log(`HealNow webhook: matched by patient-name fallback (${t.patientName}) — Rx number was missing on transfer ${t.id}`);
      return { transfer: t, item, matchedBy: 'patientName' };
    }
  }
  // Multiple candidates — refuse to guess. Log and let staff reconcile.
  context.log.warn(`HealNow webhook: ambiguous fallback for patient ${extractPatientName(event)} — ${candidates.length} candidate transfers`);
  return null;
}

// Roll the per-item paid state up to the transfer's paid status. If every item is paid we mark
// the transfer Paid; otherwise we leave the transfer-level status alone unless this is the first
// payment activity (in which case we move it from 'Pending' to a HealNow-aware state).
function rollupPaid(t) {
  const items = t.items || [];
  if (!items.length) return;
  const allPaid = items.every(i => i.paidStatus === 'paid');
  const anyPending = items.some(i => i.paidStatus === 'cart_created');
  const anyPaid = items.some(i => i.paidStatus === 'paid');
  if (allPaid) {
    t.paid = 'Paid';
    if (!t.paidAt) t.paidAt = new Date().toISOString();
  } else if (anyPaid) {
    t.paid = 'HealNow Partial';
  } else if (anyPending) {
    t.paid = 'HealNow Cart Created';
  }
}

// Fetch the receipt PDF from HealNow and upload it to our blob storage. Returns { blobName, size } or null.
async function fetchAndStoreReceipt(orderId, context) {
  const apiKey = process.env.HEALNOW_API_KEY;
  const base = process.env.HEALNOW_API_BASE || 'https://api.healnow.io/v1';
  if (!apiKey || !orderId) return null;
  try {
    const resp = await fetch(`${base}/orders/${encodeURIComponent(orderId)}/receipt`, {
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/pdf' }
    });
    if (!resp.ok) {
      context.log.warn(`HealNow receipt fetch failed: ${resp.status}`);
      return null;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const container = getBlobContainer();
    const blobName = `healnow-receipts/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${orderId}.pdf`;
    const blobClient = container.getBlockBlobClient(blobName);
    await blobClient.upload(buf, buf.length, {
      blobHTTPHeaders: { blobContentType: 'application/pdf' }
    });
    return { blobName, size: buf.length };
  } catch (e) {
    context.log.warn('HealNow receipt error:', e.message || e);
    return null;
  }
}

module.exports = async function (context, req) {
  try {
    // GET — health check / webhook validation
    if (req.method === 'GET') {
      context.res = { status: 200, body: { ok: true, service: 'healnow-webhook' } };
      return;
    }

    // Verify signature
    const rawBody = (typeof req.rawBody === 'string') ? req.rawBody : JSON.stringify(req.body || {});
    const sig = req.headers['x-healnow-signature'] || req.headers['x-webhook-signature'] || req.headers['signature'];
    const secret = process.env.HEALNOW_WEBHOOK_SECRET;
    if (secret && !verifySignature(rawBody, sig, secret)) {
      context.log.warn('HealNow webhook: signature verification failed');
      context.res = { status: 401, body: { error: 'invalid signature' } };
      return;
    }

    const event = req.body || {};
    const eventType = event.type || event.event || '';
    if (!eventType.startsWith('prescription::')) {
      // We only care about prescription-level events. Acknowledge others so HealNow doesn't retry.
      context.log(`HealNow webhook: ignoring non-prescription event type ${eventType}`);
      context.res = { status: 200, body: { ignored: eventType } };
      return;
    }

    const action = eventType.split('::')[1]; // pending | paid | canceled | removed
    const orderId = extractOrderId(event);
    const amountCents = extractAmountCents(event);

    // Match the event to a transfer item. Tries receivingRx → originRx → patient name + 60-day
    // window (in case Rx wasn't entered). Returns null when ambiguous so we don't mispaint.
    const transfers = await listTransfers(context);
    const match = findItemForEvent(transfers, event, context);
    if (!match) {
      const rxNumber = extractRxNumber(event);
      const patientName = extractPatientName(event);
      context.log.warn(`HealNow webhook ${eventType}: no transfer match. Rx=${rxNumber||'(none)'} Patient=${patientName||'(none)'}`);
      context.res = { status: 200, body: { ignored: 'no matching transfer', rxNumber, patientName } };
      return;
    }

    const { transfer: t, item, matchedBy } = match;
    const rxNumber = extractRxNumber(event);
    const now = new Date().toISOString();
    item.healnowOrderId = orderId || item.healnowOrderId || null;
    item.healnowEventAt = now;

    switch (action) {
      case 'pending':
        item.paidStatus = 'cart_created';
        item.healnowCartCreatedAt = now;
        break;
      case 'paid':
      case 'moto':
        item.paidStatus = 'paid';
        item.paidAt = now;
        item.paidAmountCents = amountCents || item.paidAmountCents || null;
        item.paidVia = (action === 'moto') ? 'phone' : 'healnow';
        // Fire-and-handle receipt fetch (best effort — webhook 200 even if it fails).
        if (orderId) {
          const receipt = await fetchAndStoreReceipt(orderId, context);
          if (receipt) item.healnowReceiptBlob = receipt.blobName;
        }
        break;
      case 'canceled':
      case 'manually_canceled':
        item.paidStatus = 'canceled';
        item.healnowCanceledAt = now;
        break;
      case 'removed':
        item.paidStatus = 'removed';
        item.healnowRemovedAt = now;
        break;
      default:
        context.log(`HealNow webhook: unknown action ${action} — recording event only`);
        item.healnowLastAction = action;
    }

    // Roll up the per-item paid state to the transfer-level paid field for the UI badge.
    rollupPaid(t);

    // Record how we matched so we have an audit trail when the patient-name fallback fires.
    item.healnowMatchedBy = matchedBy;

    // Back-fill receivingRxNumber when patient-name fallback matched and the event has one.
    // This means future events for this Rx (and humans looking at the transfer) get the canonical
    // number without anyone having to re-enter it. We only fill when the field is empty so a
    // human-entered value never gets overwritten.
    if (matchedBy === 'patientName' && rxNumber && !item.receivingRxNumber) {
      item.receivingRxNumber = rxNumber;
      item.healnowBackfilledRx = true;
      context.log(`HealNow webhook: back-filled receivingRxNumber=${rxNumber} on transfer ${t.id} item ${item.id}`);
    }

    await saveTransfer(t);
    context.log(`HealNow webhook ${eventType} applied to transfer ${t.id} item ${item.id} (matched by ${matchedBy}, Rx ${rxNumber || '(none)'})`);

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { ok: true, transferId: t.id, itemId: item.id, rxNumber, action, matchedBy }
    };
  } catch (err) {
    context.log.error('healnow-webhook error:', err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
