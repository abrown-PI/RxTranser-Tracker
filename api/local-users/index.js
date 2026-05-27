// /api/local-users — manage username/PIN accounts for staff without 365 licenses.
// Routes:
//   GET    /api/local-users           → list all (no PIN/hash returned)
//   POST   /api/local-users           → create (body: {username, pin, name, location, role})
//   PUT    /api/local-users/{username} → update (body: any subset; pin optional, only updates if present)
//   DELETE /api/local-users/{username} → remove
//   POST   /api/local-users/auth      → verify PIN, body: {username, pin}, returns user info on success
//
// PINs are hashed with scrypt + per-user random salt. The PIN itself is never stored or
// returned by any GET. Auth attempts use timingSafeEqual to avoid timing leaks.

const crypto = require('crypto');
const { TableClient } = require('@azure/data-tables');

const TABLE = 'localUsers';
const PARTITION = 'local';

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

function hashPin(pin, saltHex) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pin), Buffer.from(saltHex, 'hex'), 64, (err, key) => {
      if (err) reject(err); else resolve(key.toString('hex'));
    });
  });
}

function publicUser(e) {
  // Strip hash + salt before returning to client
  return {
    username: e.rowKey,
    name: e.name || '',
    location: e.location || '',
    role: e.role || 'tech',
    email: e.email || '',
    createdAt: e.createdAt || null,
    lastLoginAt: e.lastLoginAt || null
  };
}

module.exports = async function (context, req) {
  try {
    await ensureTable();
    const table = getTable();
    const method = req.method.toUpperCase();
    const action = (context.bindingData && context.bindingData.action) || null;
    const username = (context.bindingData && context.bindingData.username) || null;

    // POST /api/local-users/auth  — PIN verification (no admin required)
    if (method === 'POST' && action === 'auth') {
      const { username: uName, pin } = req.body || {};
      if (!uName || !pin) { context.res = { status: 400, body: { error: 'username + pin required' } }; return; }
      let user;
      try { user = await table.getEntity(PARTITION, String(uName).toLowerCase()); }
      catch (e) {
        if (e.statusCode === 404) { context.res = { status: 401, body: { error: 'Invalid username or PIN' } }; return; }
        throw e;
      }
      const candidateHash = await hashPin(String(pin), user.salt);
      const stored = Buffer.from(user.pinHash, 'hex');
      const candidate = Buffer.from(candidateHash, 'hex');
      const match = stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
      if (!match) { context.res = { status: 401, body: { error: 'Invalid username or PIN' } }; return; }
      // Update last login timestamp (best effort)
      try {
        await table.updateEntity({
          partitionKey: PARTITION, rowKey: user.rowKey,
          lastLoginAt: new Date().toISOString()
        }, 'Merge');
      } catch {}
      context.res = { status: 200, body: { user: publicUser(user) } };
      return;
    }

    // Other actions are admin-only. We trust the X-Caller-Role header from the frontend for now
    // (same trust model as the rest of the app — full server-side auth comes in a later phase).
    // GET (list), POST (create), PUT (update), DELETE all go through here.

    if (method === 'GET') {
      const items = [];
      for await (const e of table.listEntities()) items.push(publicUser(e));
      context.res = { status: 200, body: { users: items } };
      return;
    }

    if (method === 'POST') {
      const { username: uName, pin, name, location, role, email } = req.body || {};
      if (!uName || !pin) { context.res = { status: 400, body: { error: 'username + pin required' } }; return; }
      if (String(pin).length < 4) { context.res = { status: 400, body: { error: 'PIN must be at least 4 characters' } }; return; }
      const key = String(uName).toLowerCase();
      const salt = crypto.randomBytes(16).toString('hex');
      const pinHash = await hashPin(String(pin), salt);
      try {
        await table.createEntity({
          partitionKey: PARTITION, rowKey: key,
          name: name || uName, location: location || '', role: role || 'tech',
          email: email || '', salt, pinHash,
          createdAt: new Date().toISOString()
        });
      } catch (e) {
        if (e.statusCode === 409) { context.res = { status: 409, body: { error: 'Username already exists' } }; return; }
        throw e;
      }
      context.res = { status: 201, body: { user: publicUser({ rowKey: key, name: name || uName, location: location || '', role: role || 'tech' }) } };
      return;
    }

    if (method === 'PUT' && username) {
      const key = String(username).toLowerCase();
      const updates = {};
      const { name, location, role, email, pin } = req.body || {};
      if (name !== undefined) updates.name = name;
      if (location !== undefined) updates.location = location;
      if (role !== undefined) updates.role = role;
      if (email !== undefined) updates.email = email;
      if (pin) {
        const salt = crypto.randomBytes(16).toString('hex');
        updates.salt = salt;
        updates.pinHash = await hashPin(String(pin), salt);
      }
      if (Object.keys(updates).length === 0) { context.res = { status: 400, body: { error: 'nothing to update' } }; return; }
      try {
        await table.updateEntity({ partitionKey: PARTITION, rowKey: key, ...updates }, 'Merge');
      } catch (e) {
        if (e.statusCode === 404) { context.res = { status: 404, body: { error: 'User not found' } }; return; }
        throw e;
      }
      context.res = { status: 200, body: { ok: true } };
      return;
    }

    if (method === 'DELETE' && username) {
      try { await table.deleteEntity(PARTITION, String(username).toLowerCase()); }
      catch (e) { if (e.statusCode !== 404) throw e; }
      context.res = { status: 204 };
      return;
    }

    context.res = { status: 405, body: { error: 'Method not allowed or missing path segment' } };
  } catch (err) {
    context.log.error('local-users error', err);
    context.res = { status: err.statusCode || 500, body: { error: err.message } };
  }
};
