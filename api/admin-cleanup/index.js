// One-time cleanup endpoint for the Florida go-live (2026-06-01).
// POST /api/admin-cleanup
//   body: { confirm: "WIPE-TEST-DATA", tables: ["transfers", "shipments", "bulkDrafts", "audit"] }
// Wipes every row from the listed Azure Tables. Configuration tables (settings,
// users, localUsers) are never touched. Returns counts per table.
//
// Remove this endpoint after the go-live cleanup is complete.

const { TableClient } = require('@azure/data-tables');

const ALLOWED_TABLES = ['transfers', 'shipments', 'bulkDrafts', 'audit'];
const REQUIRED_CONFIRM = 'WIPE-TEST-DATA';

async function wipeTable(conn, tableName) {
  const client = TableClient.fromConnectionString(conn, tableName);
  let deleted = 0;
  try {
    // Collect first so we don't iterate + delete simultaneously
    const rows = [];
    for await (const e of client.listEntities()) {
      rows.push({ partitionKey: e.partitionKey, rowKey: e.rowKey });
    }
    for (const r of rows) {
      try { await client.deleteEntity(r.partitionKey, r.rowKey); deleted++; }
      catch (e) { if (e.statusCode !== 404) throw e; }
    }
  } catch (e) {
    if (e.statusCode === 404) return { table: tableName, deleted: 0, note: 'table not present' };
    throw e;
  }
  return { table: tableName, deleted };
}

module.exports = async function (context, req) {
  try {
    const conn = process.env.AZURE_STORAGE_CONNECTION;
    if (!conn) { context.res = { status: 503, body: { error: 'AZURE_STORAGE_CONNECTION not set' } }; return; }
    const body = req.body || {};
    if (body.confirm !== REQUIRED_CONFIRM) {
      context.res = { status: 400, body: { error: `confirm must equal "${REQUIRED_CONFIRM}"` } };
      return;
    }
    const requested = Array.isArray(body.tables) ? body.tables : ALLOWED_TABLES;
    const tables = requested.filter(t => ALLOWED_TABLES.includes(t));
    if (tables.length === 0) {
      context.res = { status: 400, body: { error: 'no valid tables specified', allowed: ALLOWED_TABLES } };
      return;
    }
    const results = [];
    for (const t of tables) {
      try { results.push(await wipeTable(conn, t)); }
      catch (e) { results.push({ table: t, error: e.message }); }
    }
    context.res = { status: 200, body: { ok: true, results } };
  } catch (err) {
    context.log.error('admin-cleanup error', err);
    context.res = { status: err.statusCode || 500, body: { error: err.message } };
  }
};
