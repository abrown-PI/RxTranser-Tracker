// POST /api/fedex-search
// Body: { references: ["T-20007", "T-20008", ...] }
//
// Queries FedEx Track API for each reference number on PI's FedEx account.
// Returns the tracking number, ship date, recipient info, and status for each reference
// that has a matching shipment.
//
// IMPORTANT: this replaces the prior date-range search. The /shipments/v1/searches endpoint
// does NOT actually exist publicly — FedEx exposes account-shipment history only via the
// Track API by-reference lookup. Staff fills the transfer ID into WorldShip's "Customer
// Reference" field when generating the label; this endpoint then resolves those references
// to tracking numbers.

let _cachedToken = null;
let _cachedTokenExpiry = 0;

async function getAccessToken() {
  if (_cachedToken && Date.now() < _cachedTokenExpiry) return _cachedToken;
  const base = process.env.FEDEX_API_BASE || 'https://apis-sandbox.fedex.com';
  const clientId = process.env.FEDEX_CLIENT_ID;
  const clientSecret = process.env.FEDEX_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw Object.assign(new Error('FedEx not configured.'), { statusCode: 503 });
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
  const resp = await fetch(base + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!resp.ok) throw Object.assign(new Error('FedEx OAuth failed: ' + resp.status), { statusCode: 502 });
  const data = await resp.json();
  _cachedToken = data.access_token;
  _cachedTokenExpiry = Date.now() + (data.expires_in - 600) * 1000;
  return _cachedToken;
}

module.exports = async function (context, req) {
  try {
    const refs = (req.body && req.body.references) || [];
    if (!Array.isArray(refs) || refs.length === 0) {
      context.res = { status: 400, body: { error: 'references array required' } };
      return;
    }
    const base = process.env.FEDEX_API_BASE || 'https://apis-sandbox.fedex.com';
    const accountNumber = process.env.FEDEX_ACCOUNT_NUMBER || '';
    const token = await getAccessToken();

    // Date window: search the last 30 days. FedEx's /track/v1/referencenumbers caps the
    // shipDate range at ~30 days (longer fails with TRACKING.SHIPDATERANGE.TOOLONG). Anything
    // older than that needs to be tracked by the actual FedEx tracking number, not reference.
    const today = new Date();
    const ninetyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const fmtDate = d => d.toISOString().slice(0, 10);

    const shipments = [];

    // FedEx Track-by-Reference endpoint /track/v1/referencenumbers takes ONE reference per call,
    // body shape: { referencesInformation: { type, value, accountNumber, carrierCode, shipDateBegin, shipDateEnd } }.
    // We run with limited concurrency to avoid hammering the API.
    async function lookupOne(reference) {
      // FedEx's "Customer reference" field in WorldShip is indexed under SHIPPER_REFERENCE.
      // Confirmed by inspecting /trackingnumbers metadata on a real shipment — the BULK-* value
      // appears in additionalTrackingInfo.packageIdentifiers with type "SHIPPER_REFERENCE".
      const body = {
        includeDetailedScans: false,
        referencesInformation: {
          type: 'SHIPPER_REFERENCE',
          value: String(reference),
          accountNumber,
          carrierCode: 'FDXE',
          shipDateBegin: fmtDate(ninetyDaysAgo),
          shipDateEnd: fmtDate(today)
        }
      };
      const resp = await fetch(base + '/track/v1/referencenumbers', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'X-locale': 'en_US' },
        body: JSON.stringify(body)
      });
      const txt = await resp.text();
      let data;
      try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
      if (!resp.ok) {
        context.log.error('FedEx track-by-reference error', resp.status, txt.slice(0, 600));
        shipments.push({ reference, error: 'FedEx ' + resp.status, found: false, fedexBody: txt.slice(0, 800) });
        return;
      }
      const out = data && data.output;
      const results = (out && Array.isArray(out.completeTrackResults)) ? out.completeTrackResults : [];
      if (!results.length) {
        shipments.push({ reference, found: false, reason: 'no matching FedEx shipment', fedexBody: txt.slice(0, 800) });
        return;
      }
      for (const r of results) {
        const first = (r.trackResults || [])[0] || {};
        const trackingNumber = (r.trackingNumber || (first.trackingNumberInfo && first.trackingNumberInfo.trackingNumber) || '').replace(/\s+/g, '');
        if (!trackingNumber || !/^\d{10,22}$/.test(trackingNumber)) continue;
        const latest = first.latestStatusDetail || {};
        const dates = first.dateAndTimes || [];
        const shipDate = (dates.find(d => d.type === 'ACTUAL_PICKUP') || dates.find(d => d.type === 'SHIP') || {}).dateTime || null;
        const deliveryDate = (dates.find(d => d.type === 'ACTUAL_DELIVERY') || dates.find(d => d.type === 'ESTIMATED_DELIVERY') || {}).dateTime || null;
        const recipientAddress = (first.recipientInformation && first.recipientInformation.address) || {};
        shipments.push({
          reference,
          found: true,
          trackingNumber,
          shipDate: shipDate ? String(shipDate).slice(0, 10) : null,
          deliveryDate,
          status: latest.statusByLocale || latest.description || latest.code || 'Unknown',
          statusCode: latest.code || null,
          recipient: {
            city: recipientAddress.city || '',
            state: recipientAddress.stateOrProvinceCode || '',
            zip: recipientAddress.postalCode || ''
          }
        });
        return;
      }
      shipments.push({ reference, found: false, reason: 'results returned but no valid tracking number', fedexBody: txt.slice(0, 800) });
    }

    const CONCURRENCY = 5;
    for (let i = 0; i < refs.length; i += CONCURRENCY) {
      await Promise.all(refs.slice(i, i + CONCURRENCY).map(lookupOne));
    }

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { shipments, queried: refs.length, found: shipments.filter(s => s.found).length }
    };
  } catch (err) {
    context.log.error('fedex-search error', err);
    context.res = { status: err.statusCode || 500, body: { error: err.message } };
  }
};
