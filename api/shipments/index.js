// /api/shipments — CRUD for user-created shipment records in Azure Table Storage.
//
// Same pattern as /api/transfers. The client also derives historical shipments
// in-memory from TRANSFERS with tracking numbers (IIFE at top of index.html);
// that derivation stays as a read-only seed. Anything the user creates or edits
// through the UI lives here so it survives reloads and is shared across users.
//
// Table schema:
//   PartitionKey: 'pi'
//   RowKey: shipment id as string
//   body: full shipment JSON
//   Plus a few indexed scalars (status, fromLocation, toLocation, trackingNumber)
//   so future filtered queries are cheap.

const { TableClient } = require('@azure/data-tables');

const TABLE = 'shipments';
const PARTITION = 'pi';

let _table = null;
function getTable() {
  if (_table) return _table;
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  if (!conn) throw Object.assign(new Error('AZURE_STORAGE_CONNECTION not set'), { statusCode: 503 });
  _table = TableClient.fromConnectionString(conn, TABLE, { allowInsecureConnection: false });
  return _table;
}

async function ensureTable() {
  try { await getTable().createTable(); } catch (e) { if (e.statusCode !== 409) throw e; }
}

function toEntity(shipment) {
  // damagePhotos can carry large dataUrls. Strip before persisting (same rule
  // as transfers) — Table Storage rows are capped at 1MB and we don't need
  // the raw image bytes in the table.
  const stripDataUrls = (obj) => {
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
  };
  const cleaned = stripDataUrls(shipment);
  return {
    partitionKey: PARTITION,
    rowKey: String(shipment.id),
    body: JSON.stringify(cleaned),
    status: shipment.status || '',
    fromLocation: shipment.fromLocation || '',
    toLocation: shipment.toLocation || '',
    trackingNumber: shipment.trackingNumber || '',
    bulkShipmentId: shipment.bulkShipmentId || '',
    createdAt: shipment.createdAt || new Date().toISOString()
  };
}

function fromEntity(e) {
  try { return JSON.parse(e.body); }
  catch { return null; }
}

module.exports = async function (context, req) {
  try {
    const method = req.method.toUpperCase();
    const id = (context.bindingData && context.bindingData.id) || null;
    await ensureTable();
    const table = getTable();

    if (method === 'GET') {
      if (id) {
        try {
          const e = await table.getEntity(PARTITION, String(id));
          const s = fromEntity(e);
          if (!s) { context.res = { status: 500, body: { error: 'Bad data' } }; return; }
          context.res = { status: 200, body: s };
        } catch (err) {
          if (err.statusCode === 404) { context.res = { status: 404, body: { error: 'Not found' } }; return; }
          throw err;
        }
      } else {
        const items = [];
        for await (const e of table.listEntities()) {
          const s = fromEntity(e);
          if (s) items.push(s);
        }
        context.res = { status: 200, body: { shipments: items } };
      }
      return;
    }

    if (method === 'POST') {
      const shipment = req.body;
      if (!shipment || !shipment.id) { context.res = { status: 400, body: { error: 'shipment.id required' } }; return; }
      await table.createEntity(toEntity(shipment));
      context.res = { status: 201, body: { id: shipment.id } };
      return;
    }

    if (method === 'PUT') {
      if (!id) { context.res = { status: 400, body: { error: 'id required in path' } }; return; }
      const shipment = req.body;
      if (!shipment) { context.res = { status: 400, body: { error: 'body required' } }; return; }
      shipment.id = +id;
      await table.upsertEntity(toEntity(shipment), 'Replace');
      context.res = { status: 200, body: { id: shipment.id } };
      return;
    }

    if (method === 'DELETE') {
      if (!id) { context.res = { status: 400, body: { error: 'id required in path' } }; return; }
      try { await table.deleteEntity(PARTITION, String(id)); } catch (e) { if (e.statusCode !== 404) throw e; }
      context.res = { status: 204 };
      return;
    }

    context.res = { status: 405, body: { error: 'Method not allowed' } };
  } catch (err) {
    context.log.error('shipments API error:', err);
    context.res = {
      status: err.statusCode || 500,
      headers: { 'Content-Type': 'application/json' },
      body: { error: err.message }
    };
  }
};
