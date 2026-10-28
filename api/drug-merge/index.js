// POST /api/drug-merge
// Admin-only. Replaces every occurrence of `from` as a drug name in the active
// transfers table with `to`. Returns a per-transfer breakdown of what was touched.
//
// Body: { from: "oldname", to: "newname", dryRun?: boolean }
//
// Scope: active table only. Archive is left untouched because the drug name on a
// Received/Delivered/Canceled transfer that's 90+ days old is historical record
// — merging would silently rewrite history for compliance queries.
//
// Guardrails:
//   - Requires admin caller (x-user-email in settings.adminEmails).
//   - Case-sensitive byte-exact match on `from` — operator picks which variant to merge.
//   - Logs an audit event per transfer that was touched (one row per transfer, not per item).

const { TableClient } = require('@azure/data-tables');

const TRANSFERS = 'transfers';
const SETTINGS = 'settings';
const AUDIT = 'audit';
const PARTITION = 'pi';

let _txTable = null, _settingsTable = null, _auditTable = null;
function getTxTable()      { if (!_txTable)       _txTable       = TableClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION, TRANSFERS); return _txTable; }
function getSettingsTable(){ if (!_settingsTable) _settingsTable = TableClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION, SETTINGS);  return _settingsTable; }
function getAuditTable()   { if (!_auditTable)    _auditTable    = TableClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION, AUDIT);     return _auditTable; }

async function isAdmin(email) {
  if (!email) return false;
  try {
    const e = await getSettingsTable().getEntity('global', 'main');
    const s = JSON.parse(e.body || '{}');
    const list = ((s.adminEmails || [])).map(x => String(x).toLowerCase());
    return list.includes(email.toLowerCase());
  } catch (err) {
    if (err.statusCode === 404) return false;
    throw err;
  }
}

function fromEntity(e) { try { return JSON.parse(e.body); } catch { return null; } }
function toEntity(t) {
  const stripDataUrls = (obj) => {
    if (!obj) return obj;
    if (Array.isArray(obj)) return obj.map(stripDataUrls);
    if (typeof obj === 'object') {
      const out = {};
      for (const k of Object.keys(obj)) { if (k === 'dataUrl') continue; out[k] = stripDataUrls(obj[k]); }
      return out;
    }
    return obj;
  };
  const cleaned = stripDataUrls(t);
  return {
    partitionKey: PARTITION,
    rowKey: String(t.id),
    body: JSON.stringify(cleaned),
    patientName: t.patientName || '',
    status: t.status || '',
    originLocation: t.originLocation || '',
    fillLocation: t.fillLocation || '',
    createdAt: t.createdAt || new Date().toISOString(),
    transferType: t.transferType || 'New'
  };
}

async function appendAudit(entry) {
  // Partition by YYYY-MM to match the client's logAudit pattern
  const ts = entry.ts || new Date().toISOString();
  const pk = ts.slice(0, 7);
  const rk = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    await getAuditTable().createEntity({
      partitionKey: pk, rowKey: rk,
      ts, actor: entry.actor || '', actorEmail: entry.actorEmail || '',
      action: entry.action || '', entityType: entry.entityType || '',
      entityId: String(entry.entityId || ''),
      details: typeof entry.details === 'string' ? entry.details : JSON.stringify(entry.details || '')
    });
  } catch (err) { /* audit is best-effort */ }
}

module.exports = async function (context, req) {
  try {
    const email = String(req.headers['x-user-email'] || '').toLowerCase().trim();
    if (!await isAdmin(email)) {
      context.res = { status: 403, body: { error: 'Admin access required' } };
      return;
    }
    const { from, to, dryRun } = req.body || {};
    if (!from || !to || typeof from !== 'string' || typeof to !== 'string') {
      context.res = { status: 400, body: { error: 'from and to (strings) required' } };
      return;
    }
    if (from === to) {
      context.res = { status: 400, body: { error: 'from and to are identical — nothing to merge' } };
      return;
    }

    const table = getTxTable();
    const touched = [];
    const errors = [];
    let scanned = 0;
    let itemsReplaced = 0;

    for await (const e of table.listEntities()) {
      scanned++;
      const t = fromEntity(e);
      if (!t || !Array.isArray(t.items) || t.items.length === 0) continue;
      let changedCount = 0;
      t.items.forEach(it => {
        if ((it.drug || '') === from) {
          it.drug = to;
          changedCount++;
        }
      });
      if (changedCount === 0) continue;
      itemsReplaced += changedCount;
      touched.push({ id: t.id, patient: t.patientName, itemsReplaced: changedCount });
      if (dryRun) continue;
      try {
        await table.upsertEntity(toEntity(t), 'Replace');
        await appendAudit({
          actor: email.split('@')[0], actorEmail: email,
          action: 'drug_merge', entityType: 'transfer', entityId: t.id,
          details: { from, to, itemsReplaced: changedCount }
        });
      } catch (err) {
        errors.push({ id: t.id, error: err.message });
      }
    }

    context.res = {
      status: 200,
      body: {
        dryRun: !!dryRun, from, to,
        stats: { scanned, transfersTouched: touched.length, itemsReplaced, errors: errors.length },
        touched: touched.slice(0, 200), // cap to keep response small
        errors
      }
    };
  } catch (err) {
    context.log.error('drug-merge error', err);
    context.res = { status: err.statusCode || 500, body: { error: err.message } };
  }
};
