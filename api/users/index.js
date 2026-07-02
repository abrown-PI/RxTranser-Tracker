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
const SETTINGS_TABLE = 'settings';
const SETTINGS_PARTITION = 'global';
const SETTINGS_ROW = 'main';

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

let _settingsTable = null;
function getSettingsTable() {
  if (_settingsTable) return _settingsTable;
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  if (!conn) throw Object.assign(new Error('AZURE_STORAGE_CONNECTION not set'), { statusCode: 503 });
  _settingsTable = TableClient.fromConnectionString(conn, SETTINGS_TABLE);
  return _settingsTable;
}
// Read admin emails from the shared settings table. Cached briefly per warm invocation to
// avoid a Table read on every request. Returns lower-cased set.
let _adminCache = { at: 0, set: new Set() };
async function loadAdminEmails() {
  const now = Date.now();
  if (now - _adminCache.at < 60000) return _adminCache.set;
  try {
    const e = await getSettingsTable().getEntity(SETTINGS_PARTITION, SETTINGS_ROW);
    const body = JSON.parse(e.body || '{}');
    const list = (body.adminEmails || []).map(x => String(x).toLowerCase());
    _adminCache = { at: now, set: new Set(list) };
  } catch (err) {
    if (err.statusCode !== 404) throw err;
    _adminCache = { at: now, set: new Set() };
  }
  return _adminCache.set;
}
function callerEmail(req) {
  return String(req.headers['x-user-email'] || '').toLowerCase().trim();
}
async function isAdminCaller(req) {
  const email = callerEmail(req);
  if (!email) return false;
  const admins = await loadAdminEmails();
  return admins.has(email);
}

function toEntity(u) {
  const out = {
    partitionKey: PARTITION,
    rowKey: String(u.email).toLowerCase(),
    name: u.name || '',
    location: u.location || '',
    role: u.role || 'tech',
    lastSignInAt: u.lastSignInAt || new Date().toISOString()
  };
  // Entra-sourced fields — only overwrite when the caller actually supplied them (sign-in
  // includes them; admin PUTs don't touch them).
  if (u.entraOfficeLocation !== undefined) out.entraOfficeLocation = u.entraOfficeLocation || '';
  if (u.entraDepartment !== undefined) out.entraDepartment = u.entraDepartment || '';
  if (u.entraJobTitle !== undefined) out.entraJobTitle = u.entraJobTitle || '';
  return out;
}
function fromEntity(e) {
  return {
    email: e.rowKey,
    name: e.name || '',
    location: e.location || '',
    role: e.role || 'tech',
    lastSignInAt: e.lastSignInAt || null,
    entraOfficeLocation: e.entraOfficeLocation || '',
    entraDepartment: e.entraDepartment || '',
    entraJobTitle: e.entraJobTitle || ''
  };
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
      const targetEmail = String(u.email).toLowerCase();
      const admin = await isAdminCaller(req);
      const caller = callerEmail(req);
      // Non-admin can only POST their own record (sign-in upsert). And even then, if the
      // record already exists we ignore any location/role fields — those belong to admin.
      if (!admin) {
        if (caller && caller !== targetEmail) {
          context.res = { status: 403, body: { error: 'only admins can create/update other users' } }; return;
        }
        let existing = null;
        try { existing = await table.getEntity(PARTITION, targetEmail); } catch (e) { if (e.statusCode !== 404) throw e; }
        if (existing) {
          // Preserve existing location/role — sign-in flow shouldn't change them from the client.
          u.location = existing.location;
          u.role = existing.role;
        } else {
          // First-time user: default to tech role at Erie until admin sets otherwise.
          if (!u.role) u.role = 'tech';
          if (!u.location) u.location = 'Erie';
        }
      }
      await table.upsertEntity(toEntity(u), 'Merge');
      context.res = { status: 200, body: { ok: true } };
      return;
    }

    if (method === 'PUT' && email) {
      const updates = req.body || {};
      const admin = await isAdminCaller(req);
      // Only admins can change location or role. Non-admins can still bump their own name
      // (e.g. display name refresh from Azure AD) — but nothing else.
      if (!admin) {
        const caller = callerEmail(req);
        if (caller !== String(email).toLowerCase()) {
          context.res = { status: 403, body: { error: 'only admins can modify other users' } }; return;
        }
        delete updates.location;
        delete updates.role;
      }
      const partial = { partitionKey: PARTITION, rowKey: String(email).toLowerCase() };
      ['name','location','role'].forEach(k => { if (updates[k] !== undefined) partial[k] = updates[k]; });
      if (Object.keys(partial).length <= 2) { context.res = { status: 400, body: { error: 'nothing to update' } }; return; }
      try { await table.updateEntity(partial, 'Merge'); }
      catch (e) { if (e.statusCode === 404) { context.res = { status: 404, body: { error: 'not found' } }; return; } throw e; }
      context.res = { status: 200, body: { ok: true } };
      return;
    }

    if (method === 'DELETE' && email) {
      if (!(await isAdminCaller(req))) {
        context.res = { status: 403, body: { error: 'only admins can delete users' } }; return;
      }
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
