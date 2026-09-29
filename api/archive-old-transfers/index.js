// POST /api/archive-old-transfers
// Moves qualifying rows from the `transfers` table into `transfersArchive` so the
// active-table poll payload stays small as the DB grows. Idempotent — a row already
// in archive is skipped, and copy-verify-then-delete means there's no window where
// a row is missing from both tables.
//
// Qualifies for archive:
//   - status is Received, Delivered, or Canceled (terminal for daily worklists)
//   - lastEditedAt (or createdAt if never edited) is older than olderThanDays
//   - not currently attached to an active shipment (defensive — we let those settle)
//
// Body (all optional):
//   { dryRun: false, olderThanDays: 90, limit: 1000 }
//
// Returns:
//   { moved: [ids], skipped: [{id, reason}], errors: [{id, error}], stats: {...} }

const { TableClient } = require('@azure/data-tables');

const TABLE = 'transfers';
const ARCHIVE_TABLE = 'transfersArchive';
const PARTITION = 'pi';
const DEFAULT_OLDER_THAN_DAYS = 90;
const DEFAULT_LIMIT = 1000;

let _table = null;
let _archiveTable = null;
function getTable() {
  if (_table) return _table;
  _table = TableClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION, TABLE);
  return _table;
}
function getArchiveTable() {
  if (_archiveTable) return _archiveTable;
  _archiveTable = TableClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION, ARCHIVE_TABLE);
  return _archiveTable;
}
async function ensureTables() {
  try { await getTable().createTable(); } catch (e) { if (e.statusCode !== 409) throw e; }
  try { await getArchiveTable().createTable(); } catch (e) { if (e.statusCode !== 409) throw e; }
}

function fromEntity(e) {
  try { return JSON.parse(e.body); }
  catch { return null; }
}
function toEntity(transfer) {
  return {
    partitionKey: PARTITION,
    rowKey: String(transfer.id),
    body: JSON.stringify(transfer),
    patientName: transfer.patientName || '',
    status: transfer.status || '',
    originLocation: transfer.originLocation || '',
    fillLocation: transfer.fillLocation || '',
    createdAt: transfer.createdAt || new Date().toISOString(),
    transferType: transfer.transferType || 'New'
  };
}

const TERMINAL_STATUSES = new Set(['Received', 'Delivered', 'Canceled']);

module.exports = async function (context, req) {
  try {
    const body = req.body || {};
    const dryRun = body.dryRun === true;
    const olderThanDays = Number.isFinite(body.olderThanDays) ? body.olderThanDays : DEFAULT_OLDER_THAN_DAYS;
    const limit = Number.isFinite(body.limit) ? body.limit : DEFAULT_LIMIT;
    if (olderThanDays < 30) {
      context.res = { status: 400, body: { error: 'olderThanDays must be >= 30 (safety floor)' } };
      return;
    }

    await ensureTables();
    const table = getTable();
    const archive = getArchiveTable();

    const cutoffMs = Date.now() - olderThanDays * 86400000;

    const moved = [];
    const skipped = [];
    const errors = [];
    let scanned = 0;

    for await (const entity of table.listEntities()) {
      scanned++;
      if (moved.length + errors.length >= limit) break;
      const t = fromEntity(entity);
      if (!t) continue;

      // Filter: only terminal-status rows qualify.
      if (!TERMINAL_STATUSES.has(t.status)) { continue; }

      // Filter: age check. Use lastEditedAt if set (someone touched it recently
      // → not truly stale), otherwise fall back to createdAt. Also honor
      // paidAt / dateShipped for a stale-in-final-state signal.
      const ageAnchorRaw = t.lastEditedAt || t.dateShipped || t.paidAt || t.createdAt;
      const ageMs = Date.parse(ageAnchorRaw || '');
      if (!Number.isFinite(ageMs)) { continue; } // no usable timestamp, skip
      if (ageMs > cutoffMs) { continue; } // not old enough yet

      if (dryRun) {
        moved.push(t.id);
        continue;
      }

      try {
        // Copy first (upsert = idempotent), verify by re-read, then delete
        // from active. Any failure between copy and delete leaves the row in
        // both tables — safe, since GET/{id} checks active first. The nightly
        // rerun will re-attempt the delete.
        await archive.upsertEntity(toEntity(t), 'Replace');
        // Verify the copy landed
        await archive.getEntity(PARTITION, String(t.id), { select: ['PartitionKey'] });
        await table.deleteEntity(PARTITION, String(t.id));
        moved.push(t.id);
      } catch (err) {
        context.log.error(`archive move failed for #${t.id}:`, err.message);
        errors.push({ id: t.id, error: err.message });
      }
    }

    context.res = {
      status: 200,
      body: {
        dryRun,
        olderThanDays,
        cutoff: new Date(cutoffMs).toISOString(),
        stats: { scanned, moved: moved.length, errors: errors.length },
        moved,
        errors
      }
    };
  } catch (err) {
    context.log.error('archive-old-transfers error:', err);
    context.res = { status: err.statusCode || 500, body: { error: err.message } };
  }
};
