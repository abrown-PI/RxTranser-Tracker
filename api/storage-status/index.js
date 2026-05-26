// GET /api/storage-status — verify Table Storage connection is wired up correctly.
// Tries to actually connect (lists tables) so we catch bad connection strings, not just missing ones.
const { TableServiceClient } = require('@azure/data-tables');

module.exports = async function (context, req) {
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  if (!conn) {
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { configured: false, error: 'AZURE_STORAGE_CONNECTION env var not set' }
    };
    return;
  }
  try {
    const svc = TableServiceClient.fromConnectionString(conn);
    const tables = [];
    for await (const t of svc.listTables()) {
      tables.push(t.name);
      if (tables.length >= 20) break;
    }
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { configured: true, tablesFound: tables }
    };
  } catch (err) {
    context.log.error('storage-status connect failed:', err);
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { configured: false, error: 'Connection failed: ' + err.message }
    };
  }
};
