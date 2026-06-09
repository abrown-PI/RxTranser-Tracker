// POST /api/fedex-track  body: { trackingNumbers: ["...", "..."] }
// Returns: { results: [{ trackingNumber, status, statusDescription, deliveryDate, lastEvent }] }
//
// Self-contained: no shared module require. Token cache lives in module scope so it
// survives across invocations on a warm instance (~5 min idle), reducing the
// /oauth/token round-trip cost.

let _cachedToken = null;
let _cachedTokenExpiry = 0;

async function getAccessToken() {
  if (_cachedToken && Date.now() < _cachedTokenExpiry) return _cachedToken;
  const base = process.env.FEDEX_API_BASE || 'https://apis-sandbox.fedex.com';
  const clientId = process.env.FEDEX_CLIENT_ID;
  const clientSecret = process.env.FEDEX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const err = new Error('FedEx not configured. Missing FEDEX_CLIENT_ID or FEDEX_CLIENT_SECRET.');
    err.statusCode = 503;
    throw err;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  });
  const resp = await fetch(base + '/oauth/token', {
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
  _cachedTokenExpiry = Date.now() + (data.expires_in - 600) * 1000;
  return _cachedToken;
}

module.exports = async function (context, req) {
  try {
    const list = (req.body && req.body.trackingNumbers) || [];
    if (!Array.isArray(list) || list.length === 0) {
      context.res = { status: 400, body: { error: 'trackingNumbers array required' } };
      return;
    }
    const base = process.env.FEDEX_API_BASE || 'https://apis-sandbox.fedex.com';
    const token = await getAccessToken();
    const cleaned = list.map(t => String(t).replace(/\s+/g, '').trim()).filter(Boolean);
    const unique = Array.from(new Set(cleaned));
    const results = [];
    for (let i = 0; i < unique.length; i += 30) {
      const chunk = unique.slice(i, i + 30);
      const body = {
        includeDetailedScans: false,
        trackingInfo: chunk.map(tn => ({
          trackingNumberInfo: { trackingNumber: tn }
        }))
      };
      const resp = await fetch(base + '/track/v1/trackingnumbers', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'X-locale': 'en_US'
        },
        body: JSON.stringify(body)
      });
      const txt = await resp.text();
      let data;
      try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
      if (!resp.ok) {
        const err = new Error('FedEx Track API ' + resp.status);
        err.statusCode = resp.status >= 500 ? 502 : resp.status;
        err.body = data;
        throw err;
      }
      const out = data && data.output;
      if (out && Array.isArray(out.completeTrackResults)) {
        out.completeTrackResults.forEach(r => {
          const tn = r.trackingNumber;
          const first = (r.trackResults || [])[0] || {};
          const latest = first.latestStatusDetail || {};
          const dates = first.dateAndTimes || [];
          const deliveryDate = (dates.find(d => d.type === 'ACTUAL_DELIVERY') || dates.find(d => d.type === 'ESTIMATED_DELIVERY') || {}).dateTime || null;
          results.push({
            trackingNumber: tn,
            status: latest.statusByLocale || latest.description || latest.code || 'Unknown',
            statusCode: latest.code || null,
            statusDescription: latest.description || null,
            deliveryDate,
            lastEvent: (first.scanEvents && first.scanEvents[0]) ? {
              date: first.scanEvents[0].date,
              eventDescription: first.scanEvents[0].eventDescription,
              location: ((first.scanEvents[0].scanLocation || {}).city || '') + (first.scanEvents[0].scanLocation && first.scanEvents[0].scanLocation.stateOrProvinceCode ? ', ' + first.scanEvents[0].scanLocation.stateOrProvinceCode : '')
            } : null
          });
        });
      }
    }
    const responseBody = { results };
    if (req.body && req.body.debug) responseBody.raw = (data && data.output) || data;
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: responseBody
    };
  } catch (err) {
    context.log.error(err);
    context.res = {
      status: err.statusCode || 500,
      headers: { 'Content-Type': 'application/json' },
      body: { error: err.message, details: err.body || null }
    };
  }
};
