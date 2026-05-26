// GET /api/fedex-status — quick health check. Used by the frontend to know whether the
// backend is configured before attempting a real call (avoids spamming error toasts).
// Self-contained on purpose: no require() of shared modules, since SWA managed Function
// deployments can be fussy about cross-folder requires.

module.exports = async function (context, req) {
  try {
    const base = process.env.FEDEX_API_BASE || 'https://apis-sandbox.fedex.com';
    const clientId = process.env.FEDEX_CLIENT_ID;
    const clientSecret = process.env.FEDEX_CLIENT_SECRET;
    const configured = !!(clientId && clientSecret);
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        configured,
        environment: base.includes('sandbox') ? 'sandbox' : 'production',
        missing: configured ? [] : [
          clientId ? null : 'FEDEX_CLIENT_ID',
          clientSecret ? null : 'FEDEX_CLIENT_SECRET'
        ].filter(Boolean)
      }
    };
  } catch (err) {
    context.log.error('fedex-status crashed:', err);
    context.res = {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: { error: err.message, stack: err.stack }
    };
  }
};
