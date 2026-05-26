// Shared FedEx helpers for all functions.
// Credentials come from Azure app settings (never hardcoded). Token cache lives in module
// scope so it survives across invocations on a warm instance (~5 min idle), reducing the
// /oauth/token round-trip cost from ~150ms per call to once every ~50 minutes.
let _cachedToken = null;
let _cachedTokenExpiry = 0;

function cfg() {
  return {
    base: process.env.FEDEX_API_BASE || 'https://apis-sandbox.fedex.com',
    clientId: process.env.FEDEX_CLIENT_ID,
    clientSecret: process.env.FEDEX_CLIENT_SECRET,
    accountNumber: process.env.FEDEX_ACCOUNT_NUMBER
  };
}

function ensureConfigured() {
  const c = cfg();
  const missing = [];
  if (!c.clientId) missing.push('FEDEX_CLIENT_ID');
  if (!c.clientSecret) missing.push('FEDEX_CLIENT_SECRET');
  if (missing.length) {
    const err = new Error('FedEx not configured. Missing app settings: ' + missing.join(', '));
    err.statusCode = 503;
    throw err;
  }
  return c;
}

async function getAccessToken() {
  if (_cachedToken && Date.now() < _cachedTokenExpiry) return _cachedToken;
  const c = ensureConfigured();
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: c.clientId,
    client_secret: c.clientSecret
  });
  const resp = await fetch(c.base + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!resp.ok) {
    const txt = await resp.text();
    const err = new Error('FedEx OAuth failed: ' + resp.status + ' ' + txt);
    err.statusCode = 502;
    throw err;
  }
  const data = await resp.json();
  _cachedToken = data.access_token;
  // FedEx tokens are 1h; refresh 10 min early to avoid clock-skew edge cases.
  _cachedTokenExpiry = Date.now() + (data.expires_in - 600) * 1000;
  return _cachedToken;
}

async function fedexFetch(path, options = {}) {
  const token = await getAccessToken();
  const c = cfg();
  const resp = await fetch(c.base + path, {
    ...options,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'X-locale': 'en_US',
      ...(options.headers || {})
    }
  });
  const txt = await resp.text();
  let parsed;
  try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt }; }
  if (!resp.ok) {
    const err = new Error('FedEx API ' + path + ' ' + resp.status);
    err.statusCode = resp.status >= 500 ? 502 : resp.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

function errorResponse(err) {
  return {
    status: err.statusCode || 500,
    headers: { 'Content-Type': 'application/json' },
    body: { error: err.message, details: err.body || null }
  };
}

module.exports = { cfg, ensureConfigured, getAccessToken, fedexFetch, errorResponse };
