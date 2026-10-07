# Transfer Tracker — Operational Runbook

Short, concrete recovery steps for the handful of things that can break this app in ways users notice.

## Doc Intelligence key stale → bulk upload returns "Doc Intelligence submit failed"

**Symptom:** Bulk upload shows an error banner like *"PDF is image-only and OCR failed on every page. First error: page 1: Doc Intelligence submit failed"*. The daily `doc-intel-healthcheck` GitHub Actions workflow may have failed overnight with an `::error::` annotation.

**Root cause:** Someone rotated the Azure Cognitive Services key on `PIRxDocIntel` but didn't update the SWA app setting. The SWA still has the old key value. Microsoft returns HTTP 401 "invalid subscription key" when the Function App tries to use it.

**Fix (~1 min):**

1. **Portal → Cognitive services → PIRxDocIntel → Keys and Endpoint** → copy **KEY 1**
2. **Portal → Static Web Apps → RxTransfer-Tracker → Environment variables** → `AZURE_DOC_INTEL_KEY` → pencil edit → delete current value → paste KEY 1 → **Apply** → **Save**
3. Wait ~30 sec for the Function App to restart.
4. Have the user hard-refresh and retry bulk upload.

**Verification:** Run the healthcheck workflow manually (GitHub → Actions → *Doc Intelligence healthcheck* → *Run workflow*). Should pass within 10 seconds.

**Prevention:** Any time anyone rotates the Doc Intelligence key on the Azure resource, they MUST also update the SWA env var in the same change. The nightly workflow catches drift within 24h as a safety net.

**Why not Key Vault?** We tried (Oct 7 2026). SWA Managed Functions don't support KV references nor managed-identity outbound calls. The Key Vault + managed identity were kept in place but are unused.

---

## MSAL sign-in loops with "interaction_in_progress"

Already self-healing — see `clearStaleMsalInteraction` in `index.html` (added `cd67b19`). If a user still gets stuck, hard-refresh clears the stale sessionStorage lock.

---

## Nightly archive job doesn't run

`.github/workflows/archive-old-transfers.yml` fires at 00:00 UTC = 7pm CT. Check GitHub → Actions → *Archive old transfers (nightly)* for the latest run. Workflow is idempotent — can be re-run manually with the **Run workflow** button if a night was missed.

---

## General: SWA deploy fails with "Failure during content distribution"

The Function App bundle exceeded SWA's ~85MB cap. Usually caused by adding a heavy `@azure/*` SDK dependency. Revert the dependency and use raw REST + `fetch` instead. See `api/parse-transfer-vision/index.js` for the pattern.
