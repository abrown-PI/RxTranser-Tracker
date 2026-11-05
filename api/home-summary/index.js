// GET /api/home-summary?location=<location>&role=<admin|tech|manager>
//
// Pre-computes just the data the Home dashboard needs and returns a small (<10KB)
// JSON blob. Home renders INSTANTLY from this while the full /api/transfers call
// (6MB+ at 2000+ rows) loads in background for other tabs. Solves the "Home shows
// Loading… for 20 seconds" complaint (Ashley, Nov 5 2026).
//
// Scoped to the user's location (same visibility rules as canSeeTransfer on the
// client — origin / fill / intake / pickup match, or admin-at-All-Locations
// returns everything). Caller sends `location` and `role` so we don't have to
// touch auth here.
//
// Response shape:
//   {
//     asOf: ISO timestamp,
//     scopeLabel: 'Erie' | 'All locations',
//     activeInQueue: number,
//     dailyCounts: { 'YYYY-MM-DD': { created, shipped, received, canceled }, ... } (last 365 days),
//     byStatus: { 'Pending Clarification': N, 'Needs Formula': N, ... },
//     pastAntShip: N,
//     unackCanceled: N,
//     recent: [{ id, patientName, status, lastTouchedAt }, ...up to 20 ],
//     shipToMix30d: { Patient: N, Pharmacy: N, 'Delivery-Lancaster': N },
//     onTimeShipRate: { period: '30d', pct: N, shipped: N, onTime: N },
//     stats: { scanned: N, visible: N }
//   }
//
// Caching: in-memory per Function instance, keyed by location+role. TTL 30 sec.
// Stale cache is served on any error so Home never appears blank.

const { TableClient } = require('@azure/data-tables');

const TABLE = 'transfers';
const PARTITION = 'pi';
const ALL_LOCATIONS = 'All locations';
const CACHE_TTL_MS = 30 * 1000;

let _table = null;
function getTable() {
  if (_table) return _table;
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  if (!conn) throw Object.assign(new Error('AZURE_STORAGE_CONNECTION not set'), { statusCode: 503 });
  _table = TableClient.fromConnectionString(conn, TABLE);
  return _table;
}

// Simple in-memory cache. Function cold starts flush it, which is fine.
const _cache = new Map(); // cacheKey -> { ts, payload }

function fromEntity(e) {
  try { return JSON.parse(e.body); } catch { return null; }
}

function canSeeTransfer(t, loc, role) {
  if (t.deletedAt) return false;
  if (role === 'admin' && loc === ALL_LOCATIONS) return true;
  if (!loc) return true; // no location filter
  if (t.originLocation === loc) return true;
  if (t.fillLocation === loc) return true;
  if (t.intakeLocation && t.intakeLocation === loc) return true;
  if (t.pickupAtPharmacy && t.pickupLocation === loc) return true;
  return false;
}

const FILL_COMPLETE = new Set(['Shipped','Delivered','Received','Canceled']);
const RECV_COMPLETE = new Set(['Received','Canceled']);
function receivingLocation(t) {
  if (t.pickupAtPharmacy) return t.pickupLocation || '';
  if (t.shipTo === 'Pharmacy') return t.originLocation || '';
  return '';
}
function isCompleteForViewer(t, loc) {
  if (t.status === 'Canceled') return true;
  const recv = receivingLocation(t);
  if (!recv) return FILL_COMPLETE.has(t.status);
  if (!loc) return RECV_COMPLETE.has(t.status);
  if (loc === t.fillLocation) return FILL_COMPLETE.has(t.status);
  if (loc === recv) return RECV_COMPLETE.has(t.status);
  return RECV_COMPLETE.has(t.status);
}

function ymd(iso) { return (iso || '').slice(0, 10); }

async function computeSummary(location, role) {
  const table = getTable();
  const scopeLabel = (role === 'admin' && location === ALL_LOCATIONS) ? 'All locations' : (location || 'All');
  // Iterate once, bucket everything we need.
  const today = new Date().toISOString().slice(0, 10);
  const byStatus = {};
  const dailyCounts = {}; // YYYY-MM-DD -> { created, shipped, received, canceled }
  const shipToMix30d = { Patient: 0, Pharmacy: 0, 'Delivery-Lancaster': 0 };
  const since30d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  let activeInQueue = 0;
  let pastAntShip = 0;
  let unackCanceled = 0;
  let scanned = 0;
  let visible = 0;
  let shipped30d = 0;
  let onTime30d = 0;
  // Keep track of recent activity — bounded min-heap-ish (just sort at end)
  const recentCandidates = [];

  const inc = (ymdKey, bucket) => {
    if (!dailyCounts[ymdKey]) dailyCounts[ymdKey] = { created: 0, shipped: 0, received: 0, canceled: 0 };
    dailyCounts[ymdKey][bucket]++;
  };

  for await (const entity of table.listEntities()) {
    scanned++;
    const t = fromEntity(entity);
    if (!t) continue;
    if (!canSeeTransfer(t, location, role)) continue;
    visible++;

    // Status buckets (for Attention panel)
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;

    // In-queue (not-complete-for-viewer) count
    if (!isCompleteForViewer(t, location)) activeInQueue++;

    // Past anticipated ship
    if (t.anticipatedShipDate && !FILL_COMPLETE.has(t.status) && t.anticipatedShipDate < today) pastAntShip++;

    // Unacknowledged cancels
    if (t.status === 'Canceled' && !t.cancelAcknowledged) unackCanceled++;

    // Daily counts
    const cYmd = ymd(t.createdAt);
    if (cYmd) inc(cYmd, 'created');
    const sYmd = ymd(t.dateShipped);
    if (sYmd) inc(sYmd, 'shipped');
    if (t.status === 'Received') {
      const rYmd = ymd(t.lastEditedAt || t.createdAt);
      if (rYmd) inc(rYmd, 'received');
    }
    if (t.status === 'Canceled') {
      const xYmd = ymd(t.canceledAt || t.lastEditedAt || t.createdAt);
      if (xYmd) inc(xYmd, 'canceled');
    }

    // Ship-to mix (last 30 days by created)
    if (cYmd && cYmd >= since30d && shipToMix30d[t.shipTo] !== undefined) shipToMix30d[t.shipTo]++;

    // On-time ship rate (last 30 days of shipped transfers)
    if (sYmd && sYmd >= since30d && t.anticipatedShipDate) {
      shipped30d++;
      if (new Date(t.dateShipped) <= new Date(t.anticipatedShipDate + 'T23:59:59')) onTime30d++;
    }

    // Recent activity candidates — cheap compare-on-insert, trim later
    const touchedAt = t.lastEditedAt || t.createdAt;
    if (touchedAt && (recentCandidates.length < 50 || touchedAt > recentCandidates[recentCandidates.length - 1].touchedAt)) {
      recentCandidates.push({ id: t.id, patientName: t.patientName, status: t.status, touchedAt });
      if (recentCandidates.length > 50) {
        recentCandidates.sort((a, b) => b.touchedAt.localeCompare(a.touchedAt));
        recentCandidates.length = 20;
      }
    }
  }

  const recent = recentCandidates
    .sort((a, b) => b.touchedAt.localeCompare(a.touchedAt))
    .slice(0, 20);

  return {
    asOf: new Date().toISOString(),
    scopeLabel,
    activeInQueue,
    dailyCounts,
    byStatus,
    pastAntShip,
    unackCanceled,
    recent,
    shipToMix30d,
    onTimeShipRate: shipped30d ? { period: '30d', pct: Math.round(100 * onTime30d / shipped30d), shipped: shipped30d, onTime: onTime30d } : null,
    stats: { scanned, visible }
  };
}

module.exports = async function (context, req) {
  try {
    const location = (req.query && req.query.location) || '';
    const role = (req.query && req.query.role) || 'tech';
    const cacheKey = `${role}|${location}`;
    const now = Date.now();
    const cached = _cache.get(cacheKey);
    if (cached && (now - cached.ts) < CACHE_TTL_MS) {
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=30', 'x-cache': 'hit' },
        body: cached.payload
      };
      return;
    }
    let payload;
    try {
      payload = await computeSummary(location, role);
    } catch (err) {
      // Stale cache fallback — Home should never appear blank on a transient
      // backend blip.
      if (cached) {
        context.res = {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'x-cache': 'stale', 'x-cache-reason': err.message.slice(0, 100) },
          body: cached.payload
        };
        return;
      }
      throw err;
    }
    _cache.set(cacheKey, { ts: now, payload });
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=30', 'x-cache': 'miss' },
      body: payload
    };
  } catch (err) {
    context.log.error('home-summary error', err);
    context.res = { status: err.statusCode || 500, body: { error: err.message } };
  }
};
