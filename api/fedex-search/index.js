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

    // Date window: search the last 90 days for these references. FedEx requires a date range
    // for reference-based lookup (you can't say "any time").
    const today = new Date();
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000);
    const fmtDate = d => d.toISOString().slice(0, 10);

    const shipments = [];
    // FedEx Track API allows up to 30 tracking info items per request. Batch in chunks.
    for (let i = 0; i < refs.length; i += 30) {
      const chunk = refs.slice(i, i + 30);
      const body = {
        includeDetailedScans: false,
        trackingInfo: chunk.map(r => ({
          trackingNumberInfo: {
            trackingNumber: String(r),
            // FEDEX_REFERENCE_NUMBER tells FedEx the "trackingNumber" field is actually a customer reference
            trackingNumberType: 'FEDEX_REFERENCE_NUMBER',
            carrierCode: 'FDXE'
          },
          shipmentAccountNumber: { value: accountNumber },
          shipDateBegin: fmtDate(ninetyDaysAgo),
          shipDateEnd: fmtDate(today)
        }))
      };
      const resp = await fetch(base + '/track/v1/trackingnumbers', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'X-locale': 'en_US' },
        body: JSON.stringify(body)
      });
      const txt = await resp.text();
      let data;
      try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
      if (!resp.ok) {
        context.log.error('FedEx track-by-reference error', resp.status, txt.slice(0, 300));
        // Don't fail the whole batch — record the error and keep going so partial results are usable
        chunk.forEach(r => shipments.push({ reference: r, error: 'FedEx ' + resp.status, found: false }));
        continue;
      }
      const out = data && data.output;
      if (!out || !Array.isArray(out.completeTrackResults)) continue;
      out.completeTrackResults.forEach((r, idx) => {
        const reference = chunk[idx]; // FedEx returns results in the order we sent them
        const first = (r.trackResults || [])[0] || {};
        const trackingNumber = (r.trackingNumber || (first.trackingNumberInfo && first.trackingNumberInfo.trackingNumber) || '').replace(/\s+/g, '');
        if (!trackingNumber) {
          shipments.push({ reference, found: false });
          return;
        }
        // FedEx Track API echoes the reference as `trackingNumber` when nothing
        // is found — guard against treating that as a match.
        if (String(trackingNumber).trim() === String(reference).trim()) {
          shipments.push({ reference, found: false, reason: 'no matching FedEx shipment' });
          return;
        }
        // Real FedEx tracking numbers are all-digit, 10-22 long.
        if (!/^\d{10,22}$/.test(trackingNumber)) {
          shipments.push({ reference, found: false, reason: 'returned value is not a valid FedEx tracking number' });
          return;
        }
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
      });
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
