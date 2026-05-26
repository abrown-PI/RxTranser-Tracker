// POST /api/fedex-search  body: { dateFrom: "YYYY-MM-DD", dateTo: "YYYY-MM-DD" }
// Returns: { shipments: [{ trackingNumber, shipDate, recipient: {...} }] }
// Self-contained — no shared module require.

let _cachedToken = null;
let _cachedTokenExpiry = 0;

async function getAccessToken() {
  if (_cachedToken && Date.now() < _cachedTokenExpiry) return _cachedToken;
  const base = process.env.FEDEX_API_BASE || 'https://apis-sandbox.fedex.com';
  const clientId = process.env.FEDEX_CLIENT_ID;
  const clientSecret = process.env.FEDEX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const err = new Error('FedEx not configured.');
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
    const err = new Error('FedEx OAuth failed: ' + resp.status);
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
    const { dateFrom, dateTo } = req.body || {};
    if (!dateFrom || !dateTo) {
      context.res = { status: 400, body: { error: 'dateFrom and dateTo (YYYY-MM-DD) required' } };
      return;
    }
    const base = process.env.FEDEX_API_BASE || 'https://apis-sandbox.fedex.com';
    const accountNumber = process.env.FEDEX_ACCOUNT_NUMBER || '';
    const token = await getAccessToken();
    const body = {
      accountNumber: { value: accountNumber },
      searchDateRange: { beginDate: dateFrom, endDate: dateTo },
      paging: { resultsPerPage: 250 }
    };
    const resp = await fetch(base + '/shipments/v1/searches', {
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
      const err = new Error('FedEx search API ' + resp.status);
      err.statusCode = resp.status >= 500 ? 502 : resp.status;
      err.body = data;
      throw err;
    }
    const out = data && data.output;
    const rawShipments = (out && (out.shipments || out.shipmentDetails)) || [];
    const shipments = rawShipments.map(s => {
      const trackingNumber = (s.trackingNumber || (s.masterTrackingNumber && s.masterTrackingNumber.trackingNumber) || '').replace(/\s+/g, '');
      const shipDate = s.shipDateStamp || s.shipDate || null;
      const r = s.recipient || s.recipientAddress || s.receiverAddress || {};
      const contact = r.contact || s.recipientContact || {};
      const addr = r.address || r;
      return {
        trackingNumber,
        shipDate,
        recipient: {
          name: contact.personName || r.personName || s.recipientName || '',
          company: contact.companyName || r.companyName || '',
          addr1: (addr.streetLines && addr.streetLines[0]) || addr.streetLine1 || '',
          addr2: (addr.streetLines && addr.streetLines[1]) || addr.streetLine2 || '',
          city: addr.city || '',
          state: addr.stateOrProvinceCode || addr.state || '',
          zip: addr.postalCode || addr.zip || '',
          country: addr.countryCode || addr.country || 'US'
        },
        service: s.serviceType || (s.service && s.service.type) || '',
        status: (s.status && (s.status.description || s.status)) || null
      };
    }).filter(s => s.trackingNumber);
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { shipments }
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
