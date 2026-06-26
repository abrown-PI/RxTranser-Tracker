// POST /api/healnow-receipt-retry  body: { transferId, itemId }
// Manually re-fetches the receipt PDF from HealNow/Tabz for a single Rx item that's marked
// paid but is missing the receipt blob. Used to diagnose receipt-fetch breakage (e.g. after
// the Tabz rebrand) — the per-item healnowReceiptError is updated with the actual error so
// it shows up next to the Retry button in the UI.

const { TableClient } = require('@azure/data-tables');
const { BlobServiceClient } = require('@azure/storage-blob');
const crypto = require('crypto');

const TRANSFERS_TABLE = 'transfers';
const BLOB_CONTAINER = 'documents';
const PARTITION = 'pi';

let _table = null;
function getTable() {
  if (_table) return _table;
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  if (!conn) throw Object.assign(new Error('AZURE_STORAGE_CONNECTION not set'), { statusCode: 503 });
  _table = TableClient.fromConnectionString(conn, TRANSFERS_TABLE);
  return _table;
}

let _container = null;
function getContainer() {
  if (_container) return _container;
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  if (!conn) throw Object.assign(new Error('AZURE_STORAGE_CONNECTION not set'), { statusCode: 503 });
  _container = BlobServiceClient.fromConnectionString(conn).getContainerClient(BLOB_CONTAINER);
  return _container;
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

async function fetchReceipt(orderId, context) {
  const apiKey = process.env.HEALNOW_API_KEY;
  const base = process.env.HEALNOW_API_BASE || 'https://api.healnow.io/v1';
  if (!apiKey) return { ok: false, error: 'HEALNOW_API_KEY not set in App Settings' };
  if (!orderId) return { ok: false, error: 'No order_id on item — webhook event may have used a different field name' };
  const url = `${base}/orders/${encodeURIComponent(orderId)}/receipt`;
  context.log(`Receipt retry: GET ${url}`);
  try {
    const resp = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/pdf' }
    });
    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.text()).slice(0, 200); } catch {}
      return { ok: false, error: `HTTP ${resp.status} from ${url}${detail ? ' — ' + detail : ''}` };
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const container = getContainer();
    const blobName = `healnow-receipts/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${orderId}.pdf`;
    await container.getBlockBlobClient(blobName).upload(buf, buf.length, {
      blobHTTPHeaders: { blobContentType: 'application/pdf' }
    });
    return { ok: true, blobName, size: buf.length };
  } catch (e) {
    return { ok: false, error: 'Network/fetch error: ' + (e.message || String(e)) };
  }
}

module.exports = async function (context, req) {
  try {
    const { transferId, itemId } = req.body || {};
    if (!transferId || !itemId) {
      context.res = { status: 400, body: { error: 'transferId and itemId required' } };
      return;
    }
    const table = getTable();
    let entity;
    try { entity = await table.getEntity(PARTITION, String(transferId)); }
    catch (e) { context.res = { status: 404, body: { error: 'Transfer not found' } }; return; }
    const transfer = JSON.parse(entity.body);
    const item = (transfer.items || []).find(i => String(i.id) === String(itemId));
    if (!item) { context.res = { status: 404, body: { error: 'Item not found on transfer' } }; return; }

    const result = await fetchReceipt(item.healnowOrderId, context);
    const now = new Date().toISOString();
    if (result.ok) {
      item.healnowReceiptBlob = result.blobName;
      item.healnowReceiptError = null;
    } else {
      item.healnowReceiptError = result.error;
    }
    item.healnowReceiptAttemptAt = now;

    // Persist
    const cleaned = stripDataUrls(transfer);
    await table.upsertEntity({
      partitionKey: PARTITION,
      rowKey: String(transfer.id),
      body: JSON.stringify(cleaned),
      patientName: transfer.patientName || '',
      status: transfer.status || '',
      originLocation: transfer.originLocation || '',
      fillLocation: transfer.fillLocation || '',
      createdAt: transfer.createdAt || now,
      transferType: transfer.transferType || 'New'
    }, 'Replace');

    context.res = { status: result.ok ? 200 : 502, body: result };
  } catch (err) {
    context.log.error('healnow-receipt-retry error', err);
    context.res = { status: err.statusCode || 500, body: { error: err.message } };
  }
};
