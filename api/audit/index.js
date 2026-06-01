// /api/audit — minimal append-only audit log of PHI access and modifications.
//
// POST /api/audit body: { actor, actorEmail, action, entityType, entityId, details? }
//   Writes one row to the 'audit' table.
//
// GET /api/audit?limit=N&since=ISO
//   Returns the most recent audit rows. Admins only (enforced client-side; future:
//   server-side identity check via Static Web Apps auth header).
//
// Storage layout in Azure Table 'audit':
//   PartitionKey = YYYY-MM (so each month rolls into its own partition)
//   RowKey       = inverted-timestamp-suffix (newest first when sorted)
//   actor, actorEmail, action, entityType, entityId, details

const { TableClient } = require('@azure/data-tables');
const crypto = require('crypto');

const TABLE = 'audit';

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

module.exports = async function (context, req) {
  try {
    await ensureTable();
    const table = getTable();
    const method = req.method.toUpperCase();

    if (method === 'POST') {
      const { actor, actorEmail, action, entityType, entityId, details } = req.body || {};
      if (!action) { context.res = { status: 400, body: { error: 'action required' } }; return; }
      const now = new Date();
      const partitionKey = now.toISOString().slice(0, 7); // YYYY-MM
      // RowKey: inverted ticks + random suffix so listing newest-first works
      const ticks = (9999999999999 - now.getTime()).toString().padStart(13, '0');
      const rowKey = `${ticks}-${crypto.randomBytes(3).toString('hex')}`;
      const entity = {
        partitionKey, rowKey,
        ts: now.toISOString(),
        actor: actor || '',
        actorEmail: (actorEmail || '').toLowerCase(),
        action: String(action).slice(0, 64),
        entityType: String(entityType || '').slice(0, 32),
        entityId: String(entityId || '').slice(0, 64),
        details: details ? JSON.stringify(details).slice(0, 4000) : ''
      };
      await table.createEntity(entity);
      context.res = { status: 201, body: { ok: true } };
      return;
    }

    if (method === 'GET') {
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
      const since = req.query.since;
      // Scan newest partition first (current month) — most queries are recent
      const out = [];
      const now = new Date();
      // Iterate up to 6 most recent months
      for (let i = 0; i < 6 && out.length < limit; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const pk = d.toISOString().slice(0, 7);
        try {
          for await (const e of table.listEntities({ queryOptions: { filter: `PartitionKey eq '${pk}'` } })) {
            if (since && e.ts && e.ts < since) continue;
            out.push({
              ts: e.ts, actor: e.actor, actorEmail: e.actorEmail,
              action: e.action, entityType: e.entityType, entityId: e.entityId,
              details: e.details
            });
            if (out.length >= limit) break;
          }
        } catch (err) { if (err.statusCode !== 404) throw err; }
      }
      context.res = { status: 200, body: { entries: out } };
      return;
    }

    if (method === 'DELETE') {
      // Bulk wipe for go-live cleanup. Body must include confirm=WIPE-TEST-DATA and
      // a tables array drawn from {transfers, shipments, bulkDrafts, audit}.
      const body = req.body || {};
      if (body.confirm !== 'WIPE-TEST-DATA') {
        context.res = { status: 400, body: { error: 'confirm must equal "WIPE-TEST-DATA"' } };
        return;
      }
      const ALLOWED = ['transfers', 'shipments', 'bulkDrafts', 'audit'];
      const requested = Array.isArray(body.tables) ? body.tables : ALLOWED;
      const tables = requested.filter(t => ALLOWED.includes(t));
      const conn = process.env.AZURE_STORAGE_CONNECTION;
      if (!conn) { context.res = { status: 503, body: { error: 'AZURE_STORAGE_CONNECTION not set' } }; return; }
      const results = [];
      for (const t of tables) {
        try {
          const c = require('@azure/data-tables').TableClient.fromConnectionString(conn, t);
          const rows = [];
          try { for await (const e of c.listEntities()) rows.push({ partitionKey: e.partitionKey, rowKey: e.rowKey }); }
          catch (e) { if (e.statusCode !== 404) throw e; }
          let deleted = 0;
          for (const r of rows) {
            try { await c.deleteEntity(r.partitionKey, r.rowKey); deleted++; }
            catch (e) { if (e.statusCode !== 404) throw e; }
          }
          results.push({ table: t, deleted });
        } catch (e) {
          results.push({ table: t, error: e.message });
        }
      }
      context.res = { status: 200, body: { ok: true, results } };
      return;
    }

    context.res = { status: 405, body: { error: 'Method not allowed' } };
  } catch (err) {
    context.log.error('audit error', err);
    context.res = { status: err.statusCode || 500, body: { error: err.message } };
  }
};
