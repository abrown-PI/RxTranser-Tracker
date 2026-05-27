// /api/bulk-drafts — shared review queue, scoped to the uploader's location.
//
// Routes:
//   GET    /api/bulk-drafts?location=erie  → list drafts visible to user (location filter optional)
//   POST   /api/bulk-drafts                → create a new draft
//   PUT    /api/bulk-drafts/{id}           → update an existing draft
//   DELETE /api/bulk-drafts/{id}           → remove (approved or rejected)
//
// PartitionKey = location (lowercase, sanitized). RowKey = draft ID (stringified bulk ID).
// The draft body lives in `body` as JSON. We also denormalize a few searchable fields.

const { TableClient } = require('@azure/data-tables');

const TABLE = 'bulkDrafts';

let _table = null;
function getTable() {
  if (_table) return _table;
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  if (!conn) throw Object.assign(new Error('AZURE_STORAGE_CONNECTION not set'), { statusCode: 503 });
  _table = TableClient.fromConnectionString(conn, TABLE);
  return _table;
}
async function ensureTable() {
  try { await getTable().createTable(); } catch (e) { if (e.statusCode !== 409) throw e; }
}

// Azure Table PartitionKey can't have certain chars; lowercase + alphanumeric only
function locationKey(loc) {
  return String(loc || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '_');
}

function toEntity(draft, location, uploaderEmail) {
  return {
    partitionKey: locationKey(location),
    rowKey: String(draft.id),
    body: JSON.stringify(draft),
    location: location || '',
    uploaderEmail: uploaderEmail || '',
    createdAt: draft.createdAt || new Date().toISOString(),
    patientName: (draft.draft && draft.draft.patientName) || '',
    sourceFile: draft.sourceFile || ''
  };
}

function fromEntity(e) {
  try { return JSON.parse(e.body); }
  catch { return null; }
}

module.exports = async function (context, req) {
  try {
    await ensureTable();
    const table = getTable();
    const method = req.method.toUpperCase();
    const id = (context.bindingData && context.bindingData.id) || null;

    if (method === 'GET') {
      const location = (req.query && req.query.location) || null;
      const items = [];
      const filter = location ? { filter: `PartitionKey eq '${locationKey(location)}'` } : undefined;
      for await (const e of table.listEntities(filter)) {
        const d = fromEntity(e);
        if (d) items.push(d);
      }
      context.res = { status: 200, body: { drafts: items } };
      return;
    }

    if (method === 'POST') {
      const draft = req.body;
      if (!draft || !draft.id) { context.res = { status: 400, body: { error: 'draft.id required' } }; return; }
      const location = (draft.draft && draft.draft.originLocation) || 'unknown';
      const uploaderEmail = req.headers['x-user-email'] || '';
      await table.upsertEntity(toEntity(draft, location, uploaderEmail), 'Replace');
      context.res = { status: 201, body: { id: draft.id } };
      return;
    }

    if (method === 'PUT' && id) {
      const draft = req.body;
      if (!draft) { context.res = { status: 400, body: { error: 'body required' } }; return; }
      draft.id = +id;
      const location = (draft.draft && draft.draft.originLocation) || 'unknown';
      const uploaderEmail = req.headers['x-user-email'] || '';
      await table.upsertEntity(toEntity(draft, location, uploaderEmail), 'Replace');
      context.res = { status: 200, body: { id: draft.id } };
      return;
    }

    if (method === 'DELETE' && id) {
      // We don't know the partition (location) just from the rowKey, so scan and delete
      for await (const e of table.listEntities()) {
        if (e.rowKey === String(id)) {
          try { await table.deleteEntity(e.partitionKey, e.rowKey); } catch (err) { if (err.statusCode !== 404) throw err; }
        }
      }
      context.res = { status: 204 };
      return;
    }

    context.res = { status: 405, body: { error: 'Method not allowed' } };
  } catch (err) {
    context.log.error('bulk-drafts error', err);
    context.res = { status: err.statusCode || 500, body: { error: err.message } };
  }
};
