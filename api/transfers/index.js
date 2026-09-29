// /api/transfers — CRUD for user-created transfer records in Azure Table Storage.
// Imported historical transfers from data.js stay client-side as a read-only seed layer;
// anything created/edited via the UI lives here and survives reloads + is shared across users.
//
// Table schema:
//   PartitionKey: 'pi' (single-tenant for now; partition by store/brand later if needed)
//   RowKey: transfer id as string
//   Other columns: serialized JSON in `body` field plus indexed scalars for filtering
//
// Why JSON blob + scalars: transfers have nested items/files that don't map to flat table
// columns. Storing the full object as JSON is simpler than denormalizing, and we keep a few
// top-level fields as their own columns for cheap queries later if we need them.

const { TableClient } = require('@azure/data-tables');

const TABLE = 'transfers';
const ARCHIVE_TABLE = 'transfersArchive';
const PARTITION = 'pi';

let _table = null;
let _archiveTable = null;
function getTable() {
  if (_table) return _table;
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  if (!conn) throw Object.assign(new Error('AZURE_STORAGE_CONNECTION not set'), { statusCode: 503 });
  _table = TableClient.fromConnectionString(conn, TABLE, { allowInsecureConnection: false });
  return _table;
}
function getArchiveTable() {
  if (_archiveTable) return _archiveTable;
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  if (!conn) throw Object.assign(new Error('AZURE_STORAGE_CONNECTION not set'), { statusCode: 503 });
  _archiveTable = TableClient.fromConnectionString(conn, ARCHIVE_TABLE, { allowInsecureConnection: false });
  return _archiveTable;
}

// Create the tables if they don't exist yet. Cheap to call repeatedly; the SDK noops if exists.
async function ensureTable() {
  try { await getTable().createTable(); } catch (e) { if (e.statusCode !== 409) throw e; }
  try { await getArchiveTable().createTable(); } catch (e) { if (e.statusCode !== 409) throw e; }
}

function toEntity(transfer) {
  // Strip dataUrl from any attached files before persisting — too large for Table Storage
  // (1MB row limit). The file blobs themselves will go to Blob Storage later; for now
  // we keep metadata only and skip the actual file bytes.
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
  const cleaned = stripDataUrls(transfer);
  return {
    partitionKey: PARTITION,
    rowKey: String(transfer.id),
    body: JSON.stringify(cleaned),
    patientName: transfer.patientName || '',
    status: transfer.status || '',
    originLocation: transfer.originLocation || '',
    fillLocation: transfer.fillLocation || '',
    createdAt: transfer.createdAt || new Date().toISOString(),
    transferType: transfer.transferType || 'New'
  };
}

function fromEntity(e) {
  try { return JSON.parse(e.body); }
  catch { return null; }
}

// Cheap existence check — HEAD-style. Returns true/false instead of throwing on
// 404. Used by PUT to route writes to whichever table currently holds the row.
async function entityExists(client, id) {
  try {
    await client.getEntity(PARTITION, String(id), { select: ['PartitionKey'] });
    return true;
  } catch (err) {
    if (err.statusCode === 404) return false;
    throw err;
  }
}

module.exports = async function (context, req) {
  try {
    const method = req.method.toUpperCase();
    const id = (context.bindingData && context.bindingData.id) || null;
    await ensureTable();
    const table = getTable();

    const archive = getArchiveTable();

    if (method === 'GET') {
      if (id) {
        // Get one — check active table first, fall back to archive. This keeps
        // deep-links / direct-access to archived transfers working even after
        // nightly migration moves old rows out of the active table.
        try {
          const e = await table.getEntity(PARTITION, String(id));
          const t = fromEntity(e);
          if (!t) { context.res = { status: 500, body: { error: 'Bad data' } }; return; }
          context.res = { status: 200, body: t };
          return;
        } catch (err) {
          if (err.statusCode !== 404) throw err;
        }
        // Not in active — try archive.
        try {
          const e = await archive.getEntity(PARTITION, String(id));
          const t = fromEntity(e);
          if (!t) { context.res = { status: 500, body: { error: 'Bad data' } }; return; }
          if (t) t._archived = true; // hint to client so it can indicate the row is historical
          context.res = { status: 200, body: t };
          return;
        } catch (err) {
          if (err.statusCode === 404) { context.res = { status: 404, body: { error: 'Not found' } }; return; }
          throw err;
        }
      } else {
        // List — active table only by default. ?include=archive returns both.
        // Perf: the default load skips the archive so the poll payload stays
        // small as the DB grows. Refill picker + full-history search opt in
        // with the query param.
        const includeArchive = (req.query && (req.query.include || '').toLowerCase() === 'archive');
        const items = [];
        for await (const e of table.listEntities()) {
          const t = fromEntity(e);
          if (t) items.push(t);
        }
        if (includeArchive) {
          for await (const e of archive.listEntities()) {
            const t = fromEntity(e);
            if (t) { t._archived = true; items.push(t); }
          }
        }
        context.res = { status: 200, body: { transfers: items } };
      }
      return;
    }

    if (method === 'POST') {
      const transfer = req.body;
      if (!transfer || !transfer.id) { context.res = { status: 400, body: { error: 'transfer.id required' } }; return; }
      await table.createEntity(toEntity(transfer));
      context.res = { status: 201, body: { id: transfer.id } };
      return;
    }

    if (method === 'PUT') {
      if (!id) { context.res = { status: 400, body: { error: 'id required in path' } }; return; }
      const transfer = req.body;
      if (!transfer) { context.res = { status: 400, body: { error: 'body required' } }; return; }
      transfer.id = +id; // canonicalize id from path
      // Determine which table currently holds the row. If archived, decide by
      // status: an active-status update (In Progress, Pending Clarification,
      // Needs Formula, or Received-but-now-being-re-shipped) means the row
      // needs to come out of archive and back into active. Otherwise keep it
      // in archive so nightly poll payload stays small.
      const archivedExists = await entityExists(archive, id);
      const ACTIVE_STATUSES = new Set(['New', 'In Progress', 'Pending Clarification', 'Needs Formula', 'Shipped']);
      if (archivedExists && ACTIVE_STATUSES.has(transfer.status)) {
        // Promote back to active
        await table.upsertEntity(toEntity(transfer), 'Replace');
        try { await archive.deleteEntity(PARTITION, String(id)); } catch (e) { if (e.statusCode !== 404) throw e; }
      } else if (archivedExists) {
        // Stays archived; update in place
        await archive.upsertEntity(toEntity(transfer), 'Replace');
      } else {
        // Not archived — normal active-table upsert (default path).
        await table.upsertEntity(toEntity(transfer), 'Replace');
      }
      context.res = { status: 200, body: { id: transfer.id } };
      return;
    }

    if (method === 'DELETE') {
      if (!id) { context.res = { status: 400, body: { error: 'id required in path' } }; return; }
      // Defensive: purge from both tables so a deleted archived row can't come back.
      try { await table.deleteEntity(PARTITION, String(id)); } catch (e) { if (e.statusCode !== 404) throw e; }
      try { await archive.deleteEntity(PARTITION, String(id)); } catch (e) { if (e.statusCode !== 404) throw e; }
      context.res = { status: 204 };
      return;
    }

    context.res = { status: 405, body: { error: 'Method not allowed' } };
  } catch (err) {
    context.log.error('transfers API error:', err);
    context.res = {
      status: err.statusCode || 500,
      headers: { 'Content-Type': 'application/json' },
      body: { error: err.message }
    };
  }
};
