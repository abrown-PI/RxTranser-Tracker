// /api/users — persistence for 365-authenticated user profiles (name + role + location).
// RowKey is the lowercased email. PartitionKey is fixed 'pi'.
//
// Routes:
//   GET    /api/users           → list all
//   POST   /api/users           → upsert (also used for first-time sign-in)
//   PUT    /api/users/{email}   → update specific fields
//   DELETE /api/users/{email}   → remove

const { TableClient } = require('@azure/data-tables');

const TABLE = 'users';
const PARTITION = 'pi';

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

function toEntity(u) {
  return {
    partitionKey: PARTITION,
    rowKey: String(u.email).toLowerCase(),
    name: u.name || '',
    location: u.location || '',
    role: u.role || 'tech',
    lastSignInAt: u.lastSignInAt || new Date().toISOString()
  };
}
function fromEntity(e) {
  return { email: e.rowKey, name: e.name || '', location: e.location || '', role: e.role || 'tech', lastSignInAt: e.lastSignInAt || null };
}

module.exports = async function (context, req) {
  try {
    await ensureTable();
    const table = getTable();
    const method = req.method.toUpperCase();
    const email = (context.bindingData && context.bindingData.email) || null;

    if (method === 'GET') {
      const items = [];
      for await (const e of table.listEntities()) items.push(fromEntity(e));
      context.res = { status: 200, body: { users: items } };
      return;
    }

    if (method === 'POST') {
      const u = req.body || {};
      if (!u.email) { context.res = { status: 400, body: { error: 'email required' } }; return; }
      await table.upsertEntity(toEntity(u), 'Merge');
      context.res = { status: 200, body: { ok: true } };
      return;
    }

    if (method === 'PUT' && email) {
      const updates = req.body || {};
      const partial = { partitionKey: PARTITION, rowKey: String(email).toLowerCase() };
      ['name','location','role'].forEach(k => { if (updates[k] !== undefined) partial[k] = updates[k]; });
      if (Object.keys(partial).length <= 2) { context.res = { status: 400, body: { error: 'nothing to update' } }; return; }
      try { await table.updateEntity(partial, 'Merge'); }
      catch (e) { if (e.statusCode === 404) { context.res = { status: 404, body: { error: 'not found' } }; return; } throw e; }
      context.res = { status: 200, body: { ok: true } };
      return;
    }

    if (method === 'DELETE' && email) {
      try { await table.deleteEntity(PARTITION, String(email).toLowerCase()); }
      catch (e) { if (e.statusCode !== 404) throw e; }
      context.res = { status: 204 };
      return;
    }

    context.res = { status: 405, body: { error: 'Method not allowed' } };
  } catch (err) {
    context.log.error('users error', err);
    context.res = { status: err.statusCode || 500, body: { error: err.message } };
  }
};
