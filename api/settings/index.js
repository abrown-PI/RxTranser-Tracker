// /api/settings — GET/PUT for global app settings (Teams webhooks, etc).
// Single-row store in the 'settings' table: PartitionKey 'global', RowKey 'main'.
// Webhook URLs are NEVER returned through GET — only a redacted indicator.
// Update via PUT with the full URLs; they're stored server-side only.
//
// Body shape:
//   { teamsWebhooks: { 'Erie': 'https://...', 'Lancaster': 'https://...' }, askQuestionRouting: 'opposite-side' }
// GET response redacts webhook URLs to `{configured: true/false, location}` per entry so the
// browser can show "configured" status in Admin UI without seeing the URLs.

const { TableClient } = require('@azure/data-tables');

const TABLE = 'settings';
const PARTITION = 'global';
const ROW = 'main';

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

async function readSettings() {
  const table = getTable();
  try {
    const e = await table.getEntity(PARTITION, ROW);
    return JSON.parse(e.body || '{}');
  } catch (err) {
    if (err.statusCode === 404) return {};
    throw err;
  }
}

async function writeSettings(settings) {
  const table = getTable();
  await table.upsertEntity({
    partitionKey: PARTITION,
    rowKey: ROW,
    body: JSON.stringify(settings)
  }, 'Replace');
}

function redactWebhooks(settings) {
  const webhooks = settings.teamsWebhooks || {};
  const configured = {};
  Object.keys(webhooks).forEach(loc => {
    configured[loc] = !!webhooks[loc];
  });
  // Admin emails: NOT secret; return as-is so the UI can show + edit them
  return {
    teamsWebhooksConfigured: configured,
    askQuestionRouting: settings.askQuestionRouting || 'opposite-side',
    adminEmails: settings.adminEmails || [],
    dailySummaryRecipients: settings.dailySummaryRecipients || [],
    locationEmails: settings.locationEmails || {}
  };
}

module.exports = async function (context, req) {
  try {
    await ensureTable();
    if (req.method === 'GET') {
      const settings = await readSettings();
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: redactWebhooks(settings) };
      return;
    }
    if (req.method === 'PUT') {
      const incoming = req.body || {};
      const current = await readSettings();
      // Merge: incoming webhooks overlay existing. Empty string deletes that location's URL.
      const teamsWebhooks = { ...(current.teamsWebhooks || {}) };
      if (incoming.teamsWebhooks) {
        Object.entries(incoming.teamsWebhooks).forEach(([loc, url]) => {
          if (url === '') delete teamsWebhooks[loc]; else teamsWebhooks[loc] = url;
        });
      }
      // Admin emails: accept full replacement array if provided (no merge — explicit list)
      let adminEmails = current.adminEmails || [];
      if (Array.isArray(incoming.adminEmails)) {
        adminEmails = incoming.adminEmails.map(e => String(e).toLowerCase().trim()).filter(Boolean);
      }
      // Daily summary recipients — full replacement array if provided
      let dailySummaryRecipients = current.dailySummaryRecipients || [];
      if (Array.isArray(incoming.dailySummaryRecipients)) {
        dailySummaryRecipients = incoming.dailySummaryRecipients.map(e => String(e).toLowerCase().trim()).filter(Boolean);
      }
      // Per-location emails — store as array of addresses (multiple recipients per location).
      // Merge incoming object onto current.
      let locationEmails = { ...(current.locationEmails || {}) };
      if (incoming.locationEmails && typeof incoming.locationEmails === 'object') {
        Object.entries(incoming.locationEmails).forEach(([loc, val]) => {
          let arr;
          if (Array.isArray(val)) arr = val.map(s => String(s).trim().toLowerCase()).filter(Boolean);
          else if (val) arr = String(val).split(/[,\n;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
          else arr = [];
          if (arr.length === 0) delete locationEmails[loc];
          else locationEmails[loc] = arr;
        });
      }
      const merged = {
        ...current,
        teamsWebhooks,
        adminEmails,
        dailySummaryRecipients,
        locationEmails,
        askQuestionRouting: incoming.askQuestionRouting || current.askQuestionRouting || 'opposite-side'
      };
      await writeSettings(merged);
      context.res = { status: 200, body: redactWebhooks(merged) };
      return;
    }
    context.res = { status: 405, body: { error: 'Method not allowed' } };
  } catch (err) {
    context.log.error('settings error', err);
    context.res = { status: err.statusCode || 500, body: { error: err.message } };
  }
};
