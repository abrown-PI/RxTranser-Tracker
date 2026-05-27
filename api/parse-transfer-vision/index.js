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
    // Auto-retry on 429 (rate limit) up to 4 times with exponential backoff — F0 free tier
    // is capped at 20 calls/minute so bulk uploads hit this frequently. Retry delays match
    // Doc Intelligence's Retry-After header when present, else exponential 2/4/8/16 seconds.
    const submitUrl = `${endpoint}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30`;
    const imgBytes = Buffer.from(image, 'base64');
    let submitResp;
    let lastErrorBody = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      submitResp = await fetch(submitUrl, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Type': mediaType || 'image/png'
        },
        body: imgBytes
      });
      if (submitResp.ok) break;
      lastErrorBody = await submitResp.text();
      if (submitResp.status === 429 && attempt < 4) {
        // Honor Retry-After header (seconds) if provided; otherwise exponential backoff
        const retryAfter = parseInt(submitResp.headers.get('Retry-After') || '0', 10);
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.pow(2, attempt + 1) * 1000;
        context.log(`429 rate limit, retrying in ${waitMs}ms (attempt ${attempt + 1})`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      // Non-429 error — return immediately
      context.res = { status: 502, body: { error: 'Doc Intelligence submit failed', status: submitResp.status, detail: lastErrorBody.slice(0, 500) } };
      return;
    }
    if (!submitResp.ok) {
      context.res = { status: 502, body: { error: 'Doc Intelligence rate-limited after 5 attempts', status: submitResp.status, detail: lastErrorBody.slice(0, 500) } };
      return;
    }
    const operationLocation = submitResp.headers.get('Operation-Location') || submitResp.headers.get('operation-location');
    if (!operationLocation) {
      context.res = { status: 502, body: { error: 'No Operation-Location returned by Doc Intelligence' } };
      return;
    }

    // Step 2: Poll for completion. Each poll is its own API call counting toward rate limits,
    // so we treat 429s the same way as the submit: respect Retry-After or exponential backoff.
    // A transient 5xx is treated the same — keep trying.
    let result = null;
    let pollErrors = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(r => setTimeout(r, 1500));
      let pollResp;
      try {
        pollResp = await fetch(operationLocation, {
          headers: { 'Ocp-Apim-Subscription-Key': key }
        });
      } catch (e) {
        pollErrors++;
        if (pollErrors > 3) {
          context.res = { status: 502, body: { error: 'Doc Intelligence poll network error', detail: e.message } };
          return;
        }
        continue;
      }
      if (pollResp.status === 429 || pollResp.status >= 500) {
        // Rate limit or transient error — back off and try the SAME poll URL again
        const retryAfter = parseInt(pollResp.headers.get('Retry-After') || '0', 10);
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(8000, 1000 * (pollErrors + 1));
        pollErrors++;
        context.log(`Poll got ${pollResp.status}, backing off ${waitMs}ms`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
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
      context.res = { status: 504, body: { error: 'Doc Intelligence timed out after 40 polls (60s)' } };
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

  // Header-style signals first
  const hasTransferHeader = /TRANSFER\s*INFORMATION/i.test(T) || /Transfer\s*date/i.test(T);
  const hasForPatient = /For\s*patient\s*:/i.test(T);
  const hasPatientAndRx = /Patient\s*:/i.test(T) && /Rx\s*number/i.test(T);
  const hasRxAndDoctor = /Rx\s*number/i.test(T) && /Doctor\s*:/i.test(T);
  // Also: just look for an Rx number pattern (6-digit ID often labeled "Rx number")
  // OR a "Pharmacy Innovations" header (every transfer sheet has it)
  const hasRxNumberLike = /Rx\s*number/i.test(T) || /\bRx\s*#/i.test(T);
  const hasPharmacyInnovationsHeader = /Pharmacy\s*Innovations/i.test(T) && /DEA/i.test(T);

  const patientName = grab(/(?:Patient\s*Name|Patient\s*:|For\s*patient\s*:)\s*([A-Z][A-Z ,.'\-]+?)(?=\s*(?:DOB|Patient\s*Phone|Patient\s*DOB|Patient\s*Address|Doctor|Drug|Rx\s*number|Store|Person|Pharmacy|Date|First\s*fill|Last\s*fill|DAW|Quantity|Refills|Instructions|Transferred\s*By|Gender|Allergies|$))/i);
  const patientDOBRaw = grab(/(?:Patient\s*DOB|DOB)\s*:?\s*([0-9\/\-]+)/i);
  const patientDOB = patientDOBRaw ? (() => {
    const m = patientDOBRaw.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!m) return null;
    let [, mm, dd, yy] = m;
    if (yy.length === 2) yy = (+yy > 50 ? '19' : '20') + yy;
    return `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  })() : null;

  // Patient Address — multi-step extraction since OCR can return the block in several ways:
  // - "Patient Address: 1224 JACKSON ST N\nSAINT PETERSBURG, FL 33705"
  // - "Patient Address: 1224 JACKSON ST N SAINT PETERSBURG, FL 33705"  (no newline)
  // - "Patient Address : 1224 JACKSON ST\nSAINT PETERSBURG FL 33705"   (no comma)
  // - State may come back as "FL" or "Fl" (case varies)
  let shipAddr1 = '', shipCity = '', shipState = '', shipZip = '';
  // Step 1: pull out the address block (everything after the label up to ~200 chars or next field)
  const addrBlockMatch = T.match(/(?:Patient\s*Address|^Address)\s*:?\s*([\s\S]{0,250}?)(?=\s+(?:Drug|DAW|Doctor|Rx\s*number|Patient\s*Phone|Phone|Store|Person|Pharmacy\s*information|Date\s*Written|First\s*fill|Last\s*fill|Quantity|Refills|Instructions|Transferred\s*By|$))/i);
  const addressBlock = addrBlockMatch ? addrBlockMatch[1] : '';
  if (addressBlock) {
    // Step 2: find the city/state/zip pattern anywhere in the block. Case-insensitive state.
    // The state is anchored as exactly 2 alpha chars BETWEEN whitespace/comma and a zip.
    const csz = addressBlock.match(/([A-Za-z][A-Za-z\s.\-']{1,40}?)[,\s]+([A-Za-z]{2})[\s,]+(\d{5}(?:-\d{4})?)/);
    if (csz) {
      shipCity = csz[1].trim().replace(/[,\s]+$/, '');
      shipState = csz[2].toUpperCase().trim();
      shipZip = csz[3].trim();
      // addr1 = everything in the block BEFORE the city/state/zip match
      shipAddr1 = addressBlock.slice(0, csz.index).trim().replace(/[,\s]+$/, '');
    } else {
      // No city/state/zip detected inside the labeled block — take just the first line as addr1
      shipAddr1 = addressBlock.split(/[\r\n]/)[0].trim();
    }
  } else {
    // Fallback: find a US street + city/state/zip pattern in the Patient section if no labeled block
    const patientBlock = grab(/Patient\s*:?\s*([\s\S]{0,400}?)(?=\s*(?:Drug|DAW|Doctor|Rx\s*number|First\s*fill|Quantity|Refills|Instructions|Transferred\s*By|Store\s*name|Person\s*name|Pharmacy\s*information|$))/i);
    if (patientBlock) {
      const csz = patientBlock.match(/(\d+[A-Z0-9\s.\-,#]+?)[,\s]+([A-Za-z][A-Za-z\s.\-']{1,40}?)[,\s]+([A-Za-z]{2})[\s,]+(\d{5}(?:-\d{4})?)/);
      if (csz) {
        shipAddr1 = csz[1].trim().replace(/[,\s]+$/, '');
        shipCity = csz[2].trim();
        shipState = csz[3].toUpperCase().trim();
        shipZip = csz[4].trim();
      }
    }
  }

  const rxNumber = grab(/Rx\s*number\s*:?\s*(\S+)/i);
  const drug = grab(/Drug\s*:?\s*(.*?)(?=\s*(?:DAW|Instructions|Doctor|Date\s*Written|First\s*fill|Quantity|Refills|Patient|Rx\s*number|Store|Person|Pharmacy|Transferred\s*By|$))/i);
  const qty = grab(/Qty\s*:?\s*(\d+)/i);
  const doctorName = grab(/Doctor\s*:?\s*([A-Z][A-Z ,.'\-]+?)(?=\s*(?:Doctor\s*Phone|Doctor\s*Address|Doctor\s*DEA|DEA|Phone|Drug|Store|Person|Pharmacy|$))/i);

  // Final detection: any of the header signals OR successful extraction of BOTH patient + rx
  // (handwritten order forms don't typically yield both — they have a different layout).
  const extractedBothFields = !!(patientName && rxNumber);
  const isTransferSheet = hasTransferHeader || hasForPatient || hasPatientAndRx || hasRxAndDoctor || extractedBothFields || hasPharmacyInnovationsHeader;

  return {
    isTransferSheet, patientName, patientDOB, shipAddr1, shipCity, shipState, shipZip,
    rxNumber, drug, qty, doctorName,
    // Diagnostic signals — surfaced so we can debug why pages were/weren't detected
    _signals: { hasTransferHeader, hasForPatient, hasPatientAndRx, hasRxAndDoctor, hasPharmacyInnovationsHeader, hasRxNumberLike, extractedBothFields, textLen: T.length }
  };
}
