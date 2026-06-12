// /api/healnow-backfill — one-time catch-up for HealNow payment status.
//
// Pulls historical orders from HealNow (GET /v1/orders) for a date range, iterates each order's
// prescriptions, and applies the same match-and-update logic the webhook uses. Use this once
// after setting up the integration to back-fill transfers whose carts/payments happened before
// the webhook was wired up.
//
// Body / query:
//   from   — ISO date (default: 30 days ago)
//   to     — ISO date (default: today)
//   dryRun — bool (default false). If true, only report what WOULD update; nothing saved.
//
// Returns: { matched, applied, ignored, errors, sample[] } and a summary log.

const { TableClient } = require('@azure/data-tables');
const { BlobServiceClient } = require('@azure/storage-blob');
const crypto = require('crypto');

const TRANSFERS_TABLE = 'transfers';
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
    partitionKey: PARTITION, rowKey: String(t.id), body: JSON.stringify(cleaned),
    patientName: t.patientName || '', status: t.status || '',
    originLocation: t.originLocation || '', fillLocation: t.fillLocation || '',
    createdAt: t.createdAt || new Date().toISOString(),
    transferType: t.transferType || 'New'
  };
}

async function listTransfers() {
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

function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/[,\.]/g, ' ')
    .split(/\s+/).filter(Boolean).sort().join(' ');
}

// Match logic mirrors the webhook receiver — Rx number first, then patient name + 7d window.
function findItemForRx(transfers, rxNumber, patientName, eventDate) {
  const rxTarget = String(rxNumber || '').replace(/\s+/g, '').trim();
  if (rxTarget) {
    for (const t of transfers) {
      for (const item of (t.items || [])) {
        const candidate = String(item.receivingRxNumber || '').replace(/\s+/g, '').trim();
        if (candidate && candidate === rxTarget) return { transfer: t, item, matchedBy: 'receivingRx' };
      }
    }
    for (const t of transfers) {
      for (const item of (t.items || [])) {
        const candidate = String(item.rxNumber || '').replace(/\s+/g, '').trim();
        if (candidate && candidate === rxTarget) return { transfer: t, item, matchedBy: 'originRx' };
      }
    }
  }
  const eventName = normName(patientName);
  if (!eventName) return null;
  const windowMs = 7 * 86400000;
  const candidates = transfers.filter(t => {
    if (!t.patientName || normName(t.patientName) !== eventName) return false;
    if (['Canceled'].includes(t.status)) return false;
    const created = t.createdAt ? new Date(t.createdAt) : null;
    if (!created) return false;
    return Math.abs(eventDate - created) <= windowMs;
  });
  if (candidates.length === 1) {
    const t = candidates[0];
    const item = (t.items || []).find(i => i.paidStatus !== 'paid') || (t.items || [])[0];
    if (item) return { transfer: t, item, matchedBy: 'patientName' };
  }
  return null;
}

async function fetchAndStoreReceipt(orderId, context) {
  const apiKey = process.env.HEALNOW_API_KEY;
  const base = process.env.HEALNOW_API_BASE || 'https://api.healnow.io/v1';
  if (!apiKey || !orderId) return null;
  try {
    const resp = await fetch(`${base}/orders/${encodeURIComponent(orderId)}/receipt`, {
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/pdf' }
    });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    const container = getBlobContainer();
    const blobName = `healnow-receipts/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${orderId}.pdf`;
    const blobClient = container.getBlockBlobClient(blobName);
    await blobClient.upload(buf, buf.length, { blobHTTPHeaders: { blobContentType: 'application/pdf' } });
    return blobName;
  } catch (e) {
    context.log.warn('Receipt fetch failed:', e.message || e);
    return null;
  }
}

function rollupPaid(t) {
  const items = (t.items || []).filter(i => i.paidStatus !== 'removed');
  if (!items.length) return;
  const allPaid = items.every(i => i.paidStatus === 'paid');
  const anyPaid = items.some(i => i.paidStatus === 'paid');
  const anyCart = items.some(i => i.paidStatus === 'cart_created');
  if (allPaid) { t.paid = 'Paid'; if (!t.paidAt) t.paidAt = new Date().toISOString(); }
  else if (anyPaid) t.paid = 'HealNow Partial';
  else if (anyCart) t.paid = 'HealNow Cart Created';
}

// Fetch a single page of HealNow orders. HealNow's exact pagination + filter params aren't
// documented publicly — we try common patterns and fall back gracefully. The function returns
// { orders, nextPageToken, total } where nextPageToken is undefined when we've reached the end.
async function fetchOrdersPage(from, to, page, perPage, context) {
  const apiKey = process.env.HEALNOW_API_KEY;
  const base = process.env.HEALNOW_API_BASE || 'https://api.healnow.io/v1';
  if (!apiKey) throw Object.assign(new Error('HEALNOW_API_KEY not set'), { statusCode: 503 });
  // Try common date filter names; HealNow's actual scheme will dictate which the API honors.
  // Note: `/orders` appears to default to paid orders only. Unpaid carts may live elsewhere.
  const params = new URLSearchParams({
    from, to,
    created_from: from, created_to: to,
    page: String(page), per_page: String(perPage)
  });
  const url = `${base}/orders?${params.toString()}`;
  const resp = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' }
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw Object.assign(new Error(`HealNow orders list ${resp.status}: ${txt.slice(0, 200)}`), { statusCode: resp.status });
  }
  const data = await resp.json();
  // Response could be { orders: [...], next_page: ... } or just an array.
  const orders = Array.isArray(data) ? data : (data.orders || data.data || []);
  const next = (data && (data.next_page || data.nextPage || data.has_more)) ? page + 1 : null;
  return { orders, nextPage: next };
}

// Process a single prescription record from a HealNow order and apply matching logic.
// Returns one of: 'applied', 'skipped', 'no-match', 'error'.
async function processPrescription(rx, order, transfers, dryRun, sample, context) {
  const rxNumber = rx.rx_number || rx.rxNumber || rx.number || rx.eid || '';
  const patientName = (order.patient && (order.patient.full_name || order.patient.name)) ||
    [order.patient && (order.patient.first_name || order.patient.firstName), order.patient && (order.patient.last_name || order.patient.lastName)].filter(Boolean).join(' ') ||
    order.patient_name || '';
  const eventDate = new Date(order.created_at || order.createdAt || rx.paid_at || Date.now());

  const match = findItemForRx(transfers, rxNumber, patientName, eventDate);
  if (!match) return { result: 'no-match', rxNumber, patientName };

  const { transfer: t, item, matchedBy } = match;

  // Derive the right paidStatus from the prescription's state on HealNow.
  // We use the explicit `status` field if present, otherwise fall back to order/payment state.
  // HealNow uses several cart-like statuses for unpaid orders: pending, open, cart, draft, processing.
  const rxStatus = String(rx.status || rx.payment_status || '').toLowerCase();
  const orderStatus = String(order.status || '').toLowerCase();
  const CART_STATES = ['pending', 'open', 'cart', 'draft', 'processing', 'created', 'cart_created', 'incomplete'];
  const PAID_STATES = ['paid', 'completed', 'complete', 'fulfilled', 'succeeded'];
  const CANCEL_STATES = ['canceled', 'cancelled', 'manually_canceled', 'declined'];
  const REMOVED_STATES = ['removed', 'deleted', 'voided'];
  let newPaidStatus = null;
  let amountCents = rx.amount_in_cents || rx.amount || null;

  if (PAID_STATES.includes(rxStatus) || (PAID_STATES.includes(orderStatus) && !CANCEL_STATES.includes(rxStatus) && !REMOVED_STATES.includes(rxStatus))) {
    newPaidStatus = 'paid';
  } else if (CANCEL_STATES.includes(rxStatus) || CANCEL_STATES.includes(orderStatus)) {
    newPaidStatus = 'canceled';
  } else if (REMOVED_STATES.includes(rxStatus)) {
    newPaidStatus = 'removed';
  } else if (CART_STATES.includes(rxStatus) || CART_STATES.includes(orderStatus)) {
    newPaidStatus = 'cart_created';
  } else {
    // Truly unknown — log with the status string so we can extend the list next time.
    return { result: 'skipped', reason: `unknown status rxStatus="${rxStatus}" orderStatus="${orderStatus}"`, rxNumber, transferId: t.id };
  }

  // Idempotent: if the item already has this status (or a more advanced one), don't re-apply.
  // Order of advancement: cart_created < paid (paid is terminal); canceled/removed are terminal.
  if (item.paidStatus === 'paid' && newPaidStatus !== 'paid') {
    return { result: 'skipped', reason: 'already paid', rxNumber, transferId: t.id };
  }
  if (item.paidStatus === newPaidStatus) {
    return { result: 'skipped', reason: 'no change', rxNumber, transferId: t.id };
  }

  if (!dryRun) {
    item.healnowOrderId = order.id || order.order_id || item.healnowOrderId;
    item.healnowEventAt = new Date().toISOString();
    item.healnowMatchedBy = matchedBy;
    item.paidStatus = newPaidStatus;
    if (newPaidStatus === 'paid') {
      item.paidAt = order.paid_at || rx.paid_at || new Date().toISOString();
      item.paidAmountCents = amountCents || item.paidAmountCents || null;
      item.paidVia = 'healnow';
      // Receipt fetch
      if (order.id || order.order_id) {
        const blob = await fetchAndStoreReceipt(order.id || order.order_id, context);
        if (blob) item.healnowReceiptBlob = blob;
      }
    }
    if (matchedBy === 'patientName' && rxNumber && !item.receivingRxNumber) {
      item.receivingRxNumber = rxNumber;
      item.healnowBackfilledRx = true;
    }
    rollupPaid(t);
    await saveTransfer(t);
  }
  if (sample.length < 20) sample.push({ rxNumber, patient: patientName, transferId: t.id, newPaidStatus, matchedBy, dryRun });
  return { result: 'applied', rxNumber, transferId: t.id, newPaidStatus };
}

// Look up a HealNow patient by last name + first name match. HealNow's GET /v1/patients
// supports ?last_name=X for filtering (other filter params we tried were silently ignored).
// Returns the first match whose first name also matches case-insensitively, or null.
async function findHealnowPatient(firstName, lastName, context) {
  const apiKey = process.env.HEALNOW_API_KEY;
  const base = process.env.HEALNOW_API_BASE || 'https://api.healnow.io/v1';
  if (!apiKey || !lastName) return null;
  try {
    const resp = await fetch(`${base}/patients?last_name=${encodeURIComponent(lastName)}&per_page=50`, {
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const list = Array.isArray(data) ? data : (data.data || data.patients || []);
    const fnTarget = String(firstName || '').toLowerCase().trim();
    // Prefer exact first-name match; fall back to any same-last-name patient when only one returned.
    const exact = list.find(p => {
      const fn = String(p.first_name || p.firstName || '').toLowerCase().trim();
      return fn === fnTarget;
    });
    if (exact) return exact;
    if (list.length === 1) return list[0];
    return null;
  } catch (e) {
    context.log.warn(`Patient search failed for ${lastName}: ${e.message || e}`);
    return null;
  }
}

// Fetch an unpaid cart for a HealNow patient. Returns the cart object or null.
async function fetchPatientCart(patientId, context) {
  const apiKey = process.env.HEALNOW_API_KEY;
  const base = process.env.HEALNOW_API_BASE || 'https://api.healnow.io/v1';
  if (!apiKey || !patientId) return null;
  try {
    const resp = await fetch(`${base}/patients/${encodeURIComponent(patientId)}/cart`, {
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data || null;
  } catch (e) {
    context.log.warn(`Cart fetch failed for patient ${patientId}: ${e.message || e}`);
    return null;
  }
}

// Sweep unpaid portal transfers and check each patient's HealNow cart. HealNow's cart payload
// has shape: { prescriptions: [{ rx_number, status, ... }], patient, totals }. We match by
// rx_number first (exact), then patient name fallback for items where rx_number is missing.
async function sweepCartsForUnpaidTransfers(context, dryRun) {
  const transfers = await listTransfers();
  const candidates = transfers.filter(t => {
    if (['Canceled'].includes(t.status)) return false;
    const items = t.items || [];
    if (!items.length) return false;
    return items.some(i => !i.paidStatus); // at least one item with no known HealNow state
  });
  context.log(`Cart sweep: ${candidates.length} candidate transfers`);
  let patientsChecked = 0, cartsFound = 0, applied = 0, skipped = 0, errors = 0;
  const seenPatients = new Set();
  const sample = [];
  for (const t of candidates) {
    const name = String(t.patientName || '').trim();
    if (!name) continue;
    let firstName = '', lastName = '';
    if (name.includes(',')) {
      const parts = name.split(',').map(s => s.trim());
      lastName = parts[0] || '';
      firstName = parts[1] || '';
    } else {
      const parts = name.split(/\s+/);
      firstName = parts[0] || '';
      lastName = parts.slice(1).join(' ');
    }
    const key = `${firstName.toLowerCase()}|${lastName.toLowerCase()}`;
    if (seenPatients.has(key)) continue;
    seenPatients.add(key);
    patientsChecked++;
    try {
      const patient = await findHealnowPatient(firstName, lastName, context);
      if (!patient) continue;
      // Fast pre-check: patient.cart_state tells us if there's anything to fetch.
      // Known values include 'open' (active cart) and presumably 'empty' (none).
      if (patient.cart_state && patient.cart_state !== 'open') continue;
      const cart = await fetchPatientCart(patient.id, context);
      if (!cart) continue;
      const cartRxs = cart.prescriptions || cart.items || [];
      if (!cartRxs.length) continue;
      cartsFound++;
      const portalTs = transfers.filter(x => normName(x.patientName) === normName(`${firstName} ${lastName}`));
      for (const cartRx of cartRxs) {
        const cartRxNumber = String(cartRx.rx_number || '').replace(/\s+/g, '').trim();
        const cartRxStatus = String(cartRx.status || '').toLowerCase();
        // Map cart rx status to our internal state.
        let newPaidStatus = 'cart_created';
        if (['paid','completed'].includes(cartRxStatus)) newPaidStatus = 'paid';
        else if (['canceled','cancelled','removed'].includes(cartRxStatus)) continue; // skip these here
        // Find the portal item: first by exact rx_number, then by drug name within this patient's transfers.
        let portalT = null, portalItem = null;
        for (const pt of portalTs) {
          for (const it of (pt.items || [])) {
            const itRx = String(it.receivingRxNumber || '').replace(/\s+/g, '').trim();
            const itRx2 = String(it.rxNumber || '').replace(/\s+/g, '').trim();
            if (cartRxNumber && (itRx === cartRxNumber || itRx2 === cartRxNumber)) {
              portalT = pt; portalItem = it; break;
            }
          }
          if (portalItem) break;
        }
        if (!portalItem && portalTs.length === 1) {
          // Single portal transfer + unmatched rx → take the first item without an Rx
          const pt = portalTs[0];
          portalItem = (pt.items || []).find(i => !i.paidStatus && !i.receivingRxNumber) || (pt.items || [])[0];
          portalT = pt;
        }
        if (!portalItem || !portalT) continue;
        if (portalItem.paidStatus === 'paid' || portalItem.paidStatus === 'canceled' || portalItem.paidStatus === 'removed') { skipped++; continue; }
        if (portalItem.paidStatus === newPaidStatus) { skipped++; continue; }
        if (!dryRun) {
          portalItem.paidStatus = newPaidStatus;
          portalItem.healnowCartCreatedAt = cart.created_at || new Date().toISOString();
          portalItem.healnowMatchedBy = cartRxNumber ? 'cartRx' : 'cartPatient';
          if (cartRxNumber && !portalItem.receivingRxNumber) {
            portalItem.receivingRxNumber = cartRxNumber;
            portalItem.healnowBackfilledRx = true;
          }
          rollupPaid(portalT);
          await saveTransfer(portalT);
        }
        applied++;
        if (sample.length < 20) sample.push({ patient: name, transferId: portalT.id, itemId: portalItem.id, rxNumber: cartRxNumber, status: newPaidStatus, dryRun });
      }
    } catch (e) {
      errors++;
      context.log.warn(`Cart sweep error for ${firstName} ${lastName}: ${e.message || e}`);
    }
  }
  return { patientsChecked, cartsFound, applied, skipped, errors, sample };
}

module.exports = async function (context, req) {
  try {
    if (req.method === 'GET') {
      context.res = { status: 200, body: { ok: true, service: 'healnow-backfill', usage: 'POST {from,to,dryRun} for paid orders; POST {mode:"carts",dryRun} for unpaid carts' } };
      return;
    }
    const body = req.body || {};

    // Cart sweep mode — look up unpaid carts per portal patient (HealNow's /orders only returns paid).
    if (body.mode === 'carts') {
      const dryRun = !!body.dryRun;
      const result = await sweepCartsForUnpaidTransfers(context, dryRun);
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: { dryRun, mode: 'carts', ...result } };
      return;
    }

    // Cart diag — for one specific patient name, dump the full patient record and cart attempts.
    if (body.mode === 'diagCart') {
      const apiKey = process.env.HEALNOW_API_KEY;
      const base = process.env.HEALNOW_API_BASE || 'https://api.healnow.io/v1';
      const lastName = body.lastName || 'Nazario';
      const firstName = body.firstName || 'Elizabeth';
      const out = { lastName, firstName, found: null, cartByCalls: [] };
      try {
        const r = await fetch(`${base}/patients?last_name=${encodeURIComponent(lastName)}&per_page=50`, {
          headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' }
        });
        const data = await r.json();
        const list = Array.isArray(data) ? data : (data.data || data.patients || []);
        const match = list.find(p => String(p.first_name||'').toLowerCase() === firstName.toLowerCase()) || list[0];
        out.found = match;
        if (match) {
          // Try cart with various ID formats
          for (const idKey of ['id', 'eid']) {
            const idVal = match[idKey];
            if (!idVal) continue;
            try {
              const cr = await fetch(`${base}/patients/${encodeURIComponent(idVal)}/cart`, {
                headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' }
              });
              const ctxt = await cr.text();
              let cparsed; try { cparsed = JSON.parse(ctxt); } catch { cparsed = { raw: ctxt.slice(0,300) }; }
              out.cartByCalls.push({ idKey, idVal, status: cr.status, topKeys: cparsed && typeof cparsed === 'object' ? Object.keys(cparsed) : null, body: cparsed });
            } catch (e) { out.cartByCalls.push({ idKey, idVal, error: e.message }); }
          }
        }
      } catch (e) { out.error = e.message; }
      context.res = { status: 200, body: out };
      return;
    }

    // Diag mode — call HealNow's /patients endpoint with no params and dump the response shape.
    // Plus a targeted search for one specific patient. Useful to figure out what query format HealNow accepts.
    if (body.mode === 'diagPatients') {
      const apiKey = process.env.HEALNOW_API_KEY;
      const base = process.env.HEALNOW_API_BASE || 'https://api.healnow.io/v1';
      const target = body.patient || 'Nazario';
      const diagOut = { tried: [], unfiltered: null };
      // Try unfiltered list first
      try {
        const r1 = await fetch(`${base}/patients?per_page=5`, { headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' } });
        const txt1 = await r1.text();
        let parsed; try { parsed = JSON.parse(txt1); } catch { parsed = { raw: txt1.slice(0,500) }; }
        diagOut.unfiltered = {
          status: r1.status,
          topLevelKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed) : null,
          firstPatient: Array.isArray(parsed) ? parsed[0] : (parsed.patients?.[0] || parsed.data?.[0] || null),
          totalReturned: Array.isArray(parsed) ? parsed.length : (parsed.patients?.length || parsed.data?.length || 0)
        };
      } catch (e) { diagOut.unfiltered = { error: e.message }; }
      // Try various filter shapes
      const shapes = [
        `?last_name=${encodeURIComponent(target)}`,
        `?lastName=${encodeURIComponent(target)}`,
        `?search=${encodeURIComponent(target)}`,
        `?q=${encodeURIComponent(target)}`,
        `?name=${encodeURIComponent(target)}`,
        `?filter[last_name]=${encodeURIComponent(target)}`
      ];
      for (const s of shapes) {
        try {
          const r = await fetch(`${base}/patients${s}`, { headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' } });
          const txt = await r.text();
          let parsed; try { parsed = JSON.parse(txt); } catch { parsed = null; }
          const list = Array.isArray(parsed) ? parsed : (parsed?.patients || parsed?.data || []);
          diagOut.tried.push({ url: s, status: r.status, count: list.length, firstMatchName: list[0] ? `${list[0].first_name||list[0].firstName||''} ${list[0].last_name||list[0].lastName||''}` : null });
        } catch (e) { diagOut.tried.push({ url: s, error: e.message }); }
      }
      context.res = { status: 200, body: diagOut };
      return;
    }
    const today = new Date();
    const defaultFrom = new Date(today.getTime() - 30 * 86400000);
    const fmt = d => d.toISOString().slice(0, 10);
    const from = body.from || req.query.from || fmt(defaultFrom);
    const to = body.to || req.query.to || fmt(today);
    const dryRun = !!(body.dryRun || req.query.dryRun);

    context.log(`HealNow backfill starting: from=${from} to=${to} dryRun=${dryRun}`);

    const transfers = await listTransfers();
    let applied = 0, skipped = 0, noMatch = 0, errors = 0, pagesFetched = 0, ordersSeen = 0, rxSeen = 0;
    const sample = [];
    const errSamples = [];
    // Optional: surface every order matching this patient name (substring, case-insensitive)
    // so we can diagnose why a specific patient isn't matching.
    const patientFilter = String(body.patientFilter || '').toLowerCase();
    const patientMatches = [];

    let page = 1;
    const PER_PAGE = 50;
    const MAX_PAGES = 50; // hard cap to avoid runaway calls; ~2500 orders covered per run
    const firstPageSample = body.debug ? [] : null;
    while (page <= MAX_PAGES) {
      let pageData;
      try { pageData = await fetchOrdersPage(from, to, page, PER_PAGE, context); }
      catch (e) {
        errors++;
        errSamples.push(`page ${page}: ${e.message || e}`);
        break;
      }
      pagesFetched++;
      const orders = pageData.orders || [];
      if (!orders.length) break;
      ordersSeen += orders.length;
      // Debug: capture a redacted snapshot of the first page so we can see HealNow's response shape.
      if (firstPageSample && page === 1 && orders.length) {
        const o = orders[0];
        const firstRx = (o.prescriptions || o.line_items || o.items || [])[0] || {};
        firstPageSample.push({
          firstOrderKeys: Object.keys(o || {}),
          firstOrderId: o.id || o.order_id,
          firstOrderEid: o.eid,
          firstOrderRef: o.ref,
          firstOrderDescription: o.description,
          firstOrderStatus: o.status,
          firstOrderCreated: o.created_at || o.createdAt,
          lastOrderCreated: orders[orders.length-1].created_at || orders[orders.length-1].createdAt,
          firstPrescriptionKeys: Object.keys(firstRx),
          firstPrescription: firstRx,
          patientKeys: Object.keys(o.patient || {}),
          firstOrderPatient: {
            name: o.patient && (o.patient.full_name || o.patient.name),
            firstName: o.patient && (o.patient.first_name || o.patient.firstName),
            lastName: o.patient && (o.patient.last_name || o.patient.lastName),
            eid: o.patient && o.patient.eid
          },
          rawNextPageHint: pageData.nextPage
        });
      }
      for (const order of orders) {
        const prescriptions = order.prescriptions || order.line_items || order.items || [];
        if (!prescriptions.length) {
          if (order.rx_number || order.rxNumber) prescriptions.push(order);
        }
        // Patient filter — log every order matching to diagnose mismatches
        if (patientFilter) {
          const pName = `${order.patient?.first_name||''} ${order.patient?.last_name||''} ${order.patient?.full_name||''}`.toLowerCase();
          if (pName.includes(patientFilter)) {
            patientMatches.push({
              orderId: order.id, ref: order.ref, status: order.status, created: order.created_at,
              firstName: order.patient?.first_name, lastName: order.patient?.last_name,
              patientEid: order.patient?.eid, cartState: order.patient?.cart_state,
              itemCount: prescriptions.length,
              itemNames: prescriptions.map(p => p.name).slice(0, 5)
            });
          }
        }
        for (const rx of prescriptions) {
          rxSeen++;
          try {
            const out = await processPrescription(rx, order, transfers, dryRun, sample, context);
            if (out.result === 'applied') applied++;
            else if (out.result === 'skipped') skipped++;
            else if (out.result === 'no-match') noMatch++;
          } catch (e) {
            errors++;
            if (errSamples.length < 10) errSamples.push(`rx ${rx.rx_number || rx.id}: ${e.message || e}`);
          }
        }
      }
      // Defensive: even if HealNow doesn't return a next-page hint, keep trying until we get
      // an empty page (some APIs just paginate without metadata).
      page++;
      if (!pageData.nextPage && orders.length < PER_PAGE) break; // last partial page
    }

    context.log(`HealNow backfill complete: applied=${applied} skipped=${skipped} noMatch=${noMatch} errors=${errors} pages=${pagesFetched} orders=${ordersSeen} rx=${rxSeen}`);

    const out = {
      dryRun, from, to,
      pagesFetched, ordersSeen, rxSeen,
      applied, skipped, noMatch, errors,
      sample, errSamples
    };
    if (firstPageSample) out.firstPageDebug = firstPageSample;
    if (patientFilter) out.patientMatches = patientMatches;
    context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: out };
  } catch (err) {
    context.log.error('healnow-backfill error:', err);
    context.res = { status: err.statusCode || 500, body: { error: err.message } };
  }
};
