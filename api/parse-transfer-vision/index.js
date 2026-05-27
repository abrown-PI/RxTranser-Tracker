// POST /api/parse-transfer-vision
// Body: { image: "<base64 PNG>", mediaType?: "image/png" }
// Returns: { isTransferSheet, patientName, patientDOB, patientAddress*, drug, qty, rxNumber, doctorName, rawText }
//
// Uses Azure AI Document Intelligence (prebuilt-document model) for OCR + key-value extraction.
// Free tier covers 500 pages/month with 2-page-per-document limit; each call here is exactly
// one page so we stay within the limit. We do our own field interpretation from the OCR text +
// extracted key-value pairs (the prescription transfer label set isn't a pre-trained doc type).

module.exports = async function (context, req) {
  try {
    const endpoint = (process.env.AZURE_DOC_INTEL_ENDPOINT || '').replace(/\/$/, '');
    const key = process.env.AZURE_DOC_INTEL_KEY;
    if (!endpoint || !key) {
      context.res = { status: 503, body: { error: 'Document Intelligence not configured (AZURE_DOC_INTEL_ENDPOINT/KEY)' } };
      return;
    }
    const { image, mediaType } = req.body || {};
    if (!image) { context.res = { status: 400, body: { error: 'image (base64) required' } }; return; }

    // Step 1: Submit the image for analysis. Returns 202 + Operation-Location header.
    const submitUrl = `${endpoint}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-02-29-preview`;
    const imgBytes = Buffer.from(image, 'base64');
    const submitResp = await fetch(submitUrl, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': mediaType || 'image/png'
      },
      body: imgBytes
    });
    if (!submitResp.ok) {
      const txt = await submitResp.text();
      context.res = { status: 502, body: { error: 'Doc Intelligence submit failed', status: submitResp.status, detail: txt.slice(0, 500) } };
      return;
    }
    const operationLocation = submitResp.headers.get('Operation-Location') || submitResp.headers.get('operation-location');
    if (!operationLocation) {
      context.res = { status: 502, body: { error: 'No Operation-Location returned by Doc Intelligence' } };
      return;
    }

    // Step 2: Poll for completion (typically 1-3 seconds for a single page)
    let result = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      const pollResp = await fetch(operationLocation, {
        headers: { 'Ocp-Apim-Subscription-Key': key }
      });
      if (!pollResp.ok) {
        const txt = await pollResp.text();
        context.res = { status: 502, body: { error: 'Doc Intelligence poll failed', detail: txt.slice(0, 500) } };
        return;
      }
      const data = await pollResp.json();
      if (data.status === 'succeeded') { result = data; break; }
      if (data.status === 'failed') {
        context.res = { status: 502, body: { error: 'Doc Intelligence analysis failed', detail: data } };
        return;
      }
    }
    if (!result) {
      context.res = { status: 504, body: { error: 'Doc Intelligence timed out (30s)' } };
      return;
    }

    // Step 3: Parse the OCR text into our structured fields.
    // The prescription transfer sheet has labels like "Patient :", "Rx number :", etc.
    // We use the raw text + regex to extract fields — same approach as our pdf.js path.
    const fullText = (result.analyzeResult?.content || '').trim();
    const fields = extractFieldsFromText(fullText);
    context.res = {
      status: 200,
      body: {
        ...fields,
        rawText: fullText.slice(0, 4000) // truncated for safety; client can request more if needed
      }
    };
  } catch (err) {
    context.log.error('parse-transfer-vision error', err);
    context.res = { status: 500, body: { error: err.message } };
  }
};

// Extract structured fields from OCR text using the same label-anchored regex approach as
// the pdf.js path on the frontend. Kept in sync with parseTransferSheet() there.
function extractFieldsFromText(text) {
  if (!text) return { isTransferSheet: false };
  const T = text.replace(/ /g, ' ').replace(/[ \t]+/g, ' ');
  const grab = (re) => { const m = T.match(re); return m ? m[1].trim() : null; };

  const isTransferSheet = /TRANSFER\s*INFORMATION/i.test(T) || /For\s*patient\s*:/i.test(T);

  const patientName = grab(/(?:Patient\s*Name|Patient\s*:|For\s*patient\s*:)\s*([A-Z][A-Z ,.'\-]+?)(?=\s*(?:DOB|Patient\s*Phone|Patient\s*DOB|Patient\s*Address|Doctor|Drug|Rx\s*number|Store|Person|Pharmacy|Date|First\s*fill|Last\s*fill|DAW|Quantity|Refills|Instructions|Transferred\s*By|Gender|Allergies|$))/i);
  const patientDOBRaw = grab(/(?:Patient\s*DOB|DOB)\s*:?\s*([0-9\/\-]+)/i);
  const patientDOB = patientDOBRaw ? (() => {
    const m = patientDOBRaw.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!m) return null;
    let [, mm, dd, yy] = m;
    if (yy.length === 2) yy = (+yy > 50 ? '19' : '20') + yy;
    return `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  })() : null;

  const addressBlock = grab(/(?:Patient\s*Address)\s*:?\s*(.*?)(?=\s*(?:Drug|DAW|Doctor|Rx\s*number|Patient\s*Phone|Store|Person|Pharmacy|Date|First\s*fill|Last\s*fill|Quantity|Refills|Instructions|Transferred\s*By|$))/i);
  let shipAddr1 = '', shipCity = '', shipState = '', shipZip = '';
  if (addressBlock) {
    const csz = addressBlock.match(/([A-Za-z\.\-' ]+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/);
    if (csz) {
      shipCity = csz[1].trim();
      shipState = csz[2].trim();
      shipZip = csz[3].trim();
      shipAddr1 = addressBlock.replace(csz[0], '').trim();
    } else {
      shipAddr1 = addressBlock.trim();
    }
  }

  const rxNumber = grab(/Rx\s*number\s*:?\s*(\S+)/i);
  const drug = grab(/Drug\s*:?\s*(.*?)(?=\s*(?:DAW|Instructions|Doctor|Date\s*Written|First\s*fill|Quantity|Refills|Patient|Rx\s*number|Store|Person|Pharmacy|Transferred\s*By|$))/i);
  const qty = grab(/Qty\s*:?\s*(\d+)/i);
  const doctorName = grab(/Doctor\s*:?\s*([A-Z][A-Z ,.'\-]+?)(?=\s*(?:Doctor\s*Phone|Doctor\s*Address|Doctor\s*DEA|DEA|Phone|Drug|Store|Person|Pharmacy|$))/i);

  return {
    isTransferSheet, patientName, patientDOB, shipAddr1, shipCity, shipState, shipZip,
    rxNumber, drug, qty, doctorName
  };
}
