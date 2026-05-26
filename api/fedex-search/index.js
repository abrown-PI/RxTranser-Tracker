// POST /api/fedex-search  body: { dateFrom: "YYYY-MM-DD", dateTo: "YYYY-MM-DD" }
// Returns: { shipments: [{ trackingNumber, shipDate, recipient: {name, addr1, city, state, zip}, status, ... }] }
//
// Uses FedEx Shipments History (Search) API. The exact endpoint shape varies by FedEx
// product; this implementation targets the standard `/shipments/v1/searches` POST endpoint
// with the account number filter. If your account uses a different product, the
// fedexFetch call below is the only thing that needs swapping out.
const { fedexFetch, cfg, errorResponse } = require('../shared/fedex');

module.exports = async function (context, req) {
  try {
    const { dateFrom, dateTo } = req.body || {};
    if (!dateFrom || !dateTo) {
      context.res = { status: 400, body: { error: 'dateFrom and dateTo (YYYY-MM-DD) required' } };
      return;
    }
    const c = cfg();
    const body = {
      accountNumber: { value: c.accountNumber || '' },
      searchDateRange: { beginDate: dateFrom, endDate: dateTo },
      // Page size cap — FedEx default is 25; we ask for the documented max.
      paging: { resultsPerPage: 250 }
    };
    const data = await fedexFetch('/shipments/v1/searches', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    const out = data && data.output;
    const rawShipments = (out && (out.shipments || out.shipmentDetails)) || [];
    const shipments = rawShipments.map(s => {
      // FedEx response shape is inconsistent across products; normalize defensively.
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
    context.res = errorResponse(err);
  }
};
