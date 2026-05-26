// GET /api/fedex-status — quick health check. Used by the frontend to know whether the
// backend is configured before attempting a real call (avoids spamming error toasts).
const { cfg } = require('../shared/fedex');

module.exports = async function (context, req) {
  const c = cfg();
  const configured = !!(c.clientId && c.clientSecret);
  context.res = {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: {
      configured,
      environment: c.base.includes('sandbox') ? 'sandbox' : 'production',
      missing: configured ? [] : [
        c.clientId ? null : 'FEDEX_CLIENT_ID',
        c.clientSecret ? null : 'FEDEX_CLIENT_SECRET'
      ].filter(Boolean)
    }
  };
};
