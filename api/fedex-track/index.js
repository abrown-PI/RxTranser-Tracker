// POST /api/fedex-track  body: { trackingNumbers: ["...", "..."] }
// Returns: { results: [{ trackingNumber, status, statusDescription, deliveryDate, lastEvent, raw }] }
//
// Batches up to 30 numbers per FedEx Track API call. Strips down the response to the fields
// the frontend actually needs so we don't ship the entire FedEx event history over the wire
// every refresh.
const { fedexFetch, errorResponse } = require('../shared/fedex');

module.exports = async function (context, req) {
  try {
    const list = (req.body && req.body.trackingNumbers) || [];
    if (!Array.isArray(list) || list.length === 0) {
      context.res = { status: 400, body: { error: 'trackingNumbers array required' } };
      return;
    }
    // Normalize: strip spaces; FedEx accepts numbers w/o spaces.
    const cleaned = list.map(t => String(t).replace(/\s+/g, '').trim()).filter(Boolean);
    const unique = Array.from(new Set(cleaned));
    const results = [];
    // FedEx Track API allows up to 30 tracking numbers per request.
    for (let i = 0; i < unique.length; i += 30) {
      const chunk = unique.slice(i, i + 30);
      const body = {
        includeDetailedScans: false,
        trackingInfo: chunk.map(tn => ({
          trackingNumberInfo: { trackingNumber: tn }
        }))
      };
      const data = await fedexFetch('/track/v1/trackingnumbers', {
        method: 'POST',
        body: JSON.stringify(body)
      });
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
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { results }
    };
  } catch (err) {
    context.log.error(err);
    context.res = errorResponse(err);
  }
};
