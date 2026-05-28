// POST /api/notify-teams
// body: { locations: ['Erie', 'Lancaster'], transferId, patientName, drug, askedBy, question, portalUrl }
// Looks up the configured Teams webhook URL for each location and posts an adaptive card.
// Returns: { sent: [locations posted to], skipped: [locations w/ no webhook configured] }

const { TableClient } = require('@azure/data-tables');

let _table = null;
function getTable() {
  if (_table) return _table;
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  if (!conn) throw Object.assign(new Error('AZURE_STORAGE_CONNECTION not set'), { statusCode: 503 });
  _table = TableClient.fromConnectionString(conn, 'settings');
  return _table;
}

async function loadWebhooks() {
  try {
    const e = await getTable().getEntity('global', 'main');
    const settings = JSON.parse(e.body || '{}');
    return settings.teamsWebhooks || {};
  } catch (err) {
    if (err.statusCode === 404) return {};
    throw err;
  }
}

// Build a Teams Adaptive Card payload in the exact format Power Automate's
// "Send webhook alerts to a chat" + "Post in a channel" templates expect.
// Both templates validate against a schema that only allows `type` + `attachments`,
// so we keep the payload minimal (no extra convenience fields).
function buildCard({ patientName, drug, askedBy, question, portalUrl, askedLocation }) {
  const fromLine = `From ${askedBy || 'team member'}${askedLocation ? ' (' + askedLocation + ')' : ''}`;
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: `❓ Question on transfer: ${patientName || '(unnamed)'}` },
          { type: 'TextBlock', wrap: true, isSubtle: true, text: fromLine },
          ...(drug ? [{ type: 'TextBlock', wrap: true, text: `**Drug:** ${drug}` }] : []),
          { type: 'TextBlock', wrap: true, text: question || '(no question text)', spacing: 'Medium' }
        ],
        actions: portalUrl ? [{
          type: 'Action.OpenUrl',
          title: 'View Transfer in Portal',
          url: portalUrl
        }] : []
      }
    }]
  };
}

async function postToTeams(url, payload) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Accept': 'application/json',
      'User-Agent': 'PI-Transfer-Tracker/1.0'
    },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const txt = await resp.text();
    // Capture useful response headers so we can see what's going on
    const allow = resp.headers.get('allow') || resp.headers.get('Allow') || '';
    const ct = resp.headers.get('content-type') || '';
    const detail = txt ? txt.slice(0, 300) : '(empty body)';
    const hdrs = allow ? ` [allow=${allow}]` : '';
    throw new Error(`${resp.status} ${resp.statusText || ''}${hdrs} ${ct?'('+ct+')':''} — ${detail}`);
  }
}

module.exports = async function (context, req) {
  try {
    const { locations, transferId, patientName, drug, askedBy, askedLocation, question, portalUrl } = req.body || {};
    if (!Array.isArray(locations) || locations.length === 0) {
      context.res = { status: 400, body: { error: 'locations array required' } };
      return;
    }
    const webhooks = await loadWebhooks();
    const card = buildCard({ patientName, drug, askedBy, question, transferId, portalUrl, askedLocation });
    const sent = [], skipped = [], failed = [];
    for (const loc of locations) {
      const url = webhooks[loc];
      if (!url) { skipped.push(loc); continue; }
      try { await postToTeams(url, card); sent.push(loc); }
      catch (e) { context.log.error('Teams post to ' + loc + ' failed:', e.message); failed.push({ location: loc, error: e.message }); }
    }
    context.res = { status: 200, body: { sent, skipped, failed } };
  } catch (err) {
    context.log.error('notify-teams error', err);
    context.res = { status: err.statusCode || 500, body: { error: err.message } };
  }
};
