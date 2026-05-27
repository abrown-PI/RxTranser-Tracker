// /api/blobs — store + serve transfer documents (PK sheets, hard copies, CC forms, page images)
//
// POST /api/blobs body: { content: base64, contentType: "image/png", prefix?: "pages" }
//   → uploads to the "documents" container with a unique name, returns { name }
//
// GET /api/blobs/{name}
//   → streams the blob bytes with the correct content-type header
//
// Stored permanently so the receiving team can open documents from any transfer at any time.

const { BlobServiceClient } = require('@azure/storage-blob');
const crypto = require('crypto');

const CONTAINER = 'documents';

let _containerClient = null;
function getContainer() {
  if (_containerClient) return _containerClient;
  const conn = process.env.AZURE_STORAGE_CONNECTION;
  if (!conn) throw Object.assign(new Error('AZURE_STORAGE_CONNECTION not set'), { statusCode: 503 });
  const service = BlobServiceClient.fromConnectionString(conn);
  _containerClient = service.getContainerClient(CONTAINER);
  return _containerClient;
}

module.exports = async function (context, req) {
  try {
    const method = req.method.toUpperCase();
    const name = (context.bindingData && context.bindingData.name) || null;
    const container = getContainer();

    if (method === 'POST') {
      const { content, contentType, prefix } = req.body || {};
      if (!content) { context.res = { status: 400, body: { error: 'content (base64) required' } }; return; }
      // Build a unique blob name: <prefix>/<timestamp>-<random>.<ext>
      const ext = (contentType || '').includes('png') ? 'png'
                : (contentType || '').includes('jpeg') || (contentType || '').includes('jpg') ? 'jpg'
                : (contentType || '').includes('pdf') ? 'pdf'
                : 'bin';
      const blobName = `${prefix || 'doc'}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
      const blobClient = container.getBlockBlobClient(blobName);
      const buffer = Buffer.from(content, 'base64');
      await blobClient.upload(buffer, buffer.length, {
        blobHTTPHeaders: { blobContentType: contentType || 'application/octet-stream' }
      });
      context.res = { status: 201, headers: { 'Content-Type': 'application/json' }, body: { name: blobName, size: buffer.length } };
      return;
    }

    if (method === 'GET' && name) {
      const blobClient = container.getBlockBlobClient(name);
      const exists = await blobClient.exists();
      if (!exists) { context.res = { status: 404, body: { error: 'Blob not found' } }; return; }
      const dl = await blobClient.download();
      // Read the full buffer (acceptable for our document sizes — typically < 5MB each)
      const chunks = [];
      for await (const chunk of dl.readableStreamBody) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      context.res = {
        status: 200,
        headers: {
          'Content-Type': dl.contentType || 'application/octet-stream',
          'Cache-Control': 'private, max-age=3600'
        },
        body,
        isRaw: true
      };
      return;
    }

    context.res = { status: 405, body: { error: 'Method not allowed' } };
  } catch (err) {
    context.log.error('blobs error', err);
    context.res = { status: err.statusCode || 500, body: { error: err.message } };
  }
};
