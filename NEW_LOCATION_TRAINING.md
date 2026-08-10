# PI Transfer Tracker — Getting Started

**Welcome to the PI Transfer Tracker!** This is the portal we use across all 11 pharmacies to send prescriptions from one pharmacy to another (or ship compounds from Erie to a patient or a satellite location). It replaces the emails, spreadsheets, and paper packing slips we used to juggle.

**Website:** https://red-island-0bb34e510.7.azurestaticapps.net
**Full help:** click 📖 Help in the top navbar (or open [help.html](https://red-island-0bb34e510.7.azurestaticapps.net/help.html))

---

## Day-One Setup (5 minutes)

1. **Open the site** in Microsoft Edge (our standard browser).
2. Click **Sign in with Microsoft 365** — use your `@pharmacyinnovations.net` account (same one you use for Outlook and Teams).
3. Your location should default to **[LOCATION]**. If it says something else, look at the location dropdown in the navbar to switch — or ping Ashley to fix your assignment.
4. Bookmark the site.
5. Click 📖 **Help** in the navbar and skim the **🆕 What's New** section at the top so you know the current button labels.

---

## The Three Things You'll Do Most Often

### 1. Create a new transfer *(sending an Rx to another pharmacy for them to fill/dispense)*

1. Click **+ New Transfer**
2. Fill in:
   - **Patient Name** (required)
   - **Origin Location** — where the Rx originated (usually your pharmacy)
   - **Fill Location** — the pharmacy that will actually compound/dispense (Erie for compounds, another PI store for commercial products)
   - **Ship To** — Pharmacy (defaults to origin address) or Patient
   - **PK Transfer Sheet** — drop the PDF; the app auto-fills patient/DOB/drug/Rx# from the sheet
   - **Items** — one row per Rx: Origin Rx#, Drug, Qty (Receiving Rx# gets filled in later by the fill pharmacy)
3. Click **Submit transfer**

> **Bulk stack of transfers?** Click **+ New Transfer** → toggle to **Bulk Upload** → drop a multi-page PDF. The app splits each PK sheet into its own draft, OCRs scanned pages, and lets you approve them in one shot.

> **Prepared script coming for pickup at your pharmacy (not a real transfer)?** Check the blue **📍 Prescriptions will be picked up at another pharmacy (Non-transfer)** box at the top of the form. Skips the PK sheet requirement.

### 2. Receive a shipment *(a box arrives from another pharmacy)*

1. Go to the **Shipments** tab
2. Focus the **📷 Scan tracking barcode** field at the top of the page
3. Scan either the FedEx barcode OR the barcode on the bulk packing slip inside the box
4. The shipment opens → click **📦 Arrived at my pharmacy**
5. Check off each Rx as you unpack it
6. Click **Mark Package Received**

> **Some scripts didn't make the box?** Click **Receive Partial** instead of Mark Received, check off ONLY what you actually have, and leave the missing ones unchecked. Anything unchecked gets flagged as missing and the fill pharmacy is notified. If a whole patient's shipment is missing, that transfer is automatically pulled off the box and put back on the fill queue for next shipment.

### 3. Ask a question about a transfer *(need info from another pharmacy)*

1. From the Transfers list, find the patient → click **❓ Ask question**
2. Type your question → **Send Question**
3. A card lands in that pharmacy's Teams chat. They reply in the transfer's Discussion section.
4. Your unanswered questions show on the **Alerts** tab

---

## Statuses You'll See

| Status | What it means |
|---|---|
| **New** | Just created, hasn't been worked yet |
| **In Progress** | Fill pharmacy is working on it (compounding, gathering docs, etc.) |
| **Pending Clarification** | Waiting on info — check the Discussion tab |
| **Needs Formula** | Compound formula not on file yet |
| **Shipped** | Left the fill pharmacy |
| **Delivered** | FedEx marked it delivered (patient direct ships) |
| **Received** | Receiving pharmacy checked it in |
| **Canceled** | Killed before it was completed |

The **Active** view (default) hides anything that's complete for YOUR pharmacy. Flip to **Complete** or **All** if you're hunting for something you thought closed out.

---

## Shipping Basics

- **You do NOT type FedEx tracking numbers into the app.** Instead: when you generate the FedEx label in WorldShip, type either the **Transfer ID** (patient direct ship) or the **BULK Shipment ID** (pharmacy-to-pharmacy box) into WorldShip's **Customer Reference** field. A daily cron matches FedEx shipments to transfers by reference — the tracking, ship date, and status update automatically.
- Patient-direct ship: use the **Transfer ID** (shown at the top of the transfer detail modal)
- Bulk pharmacy shipment: create the shipment in the app first (Shipments → + Create Shipment), then use the **BULK ID** it generates (e.g., `BULK-2026-0142`) as the WorldShip reference

---

## The Packing Checklist (shipping team)

If you're on the shipping side, this is your daily worksheet.

1. **Shipments** tab → click **📋 Packing Checklist** (top-right)
2. All destinations for today's ship are listed, grouped by pharmacy
3. Check each Rx as you pack — teammates see your checks live
4. When a destination's box is fully packed, click **📦 Create Shipment & Print Slip (N)** on that group's header — the packing slip prints automatically with a barcode you can scan into WorldShip

---

## Things NOT To Do

- ❌ **Do not enter a refill as a new transfer.** If you're refilling something already in the app, click **+ Refill** and search for the original — this keeps the Rx History chained together. Only use + New Transfer for brand-new orders.
- ❌ **Do not skip the WorldShip Customer Reference.** If you forget to type the Transfer or BULK ID into WorldShip, the tracking won't auto-match and someone has to hunt it down manually.
- ❌ **Do not "check everything" on a bulk receive if some scripts are missing.** Use Receive Partial and only check what you actually have — otherwise the missing ones get lost in the shuffle.

---

## Who to Ask for Help

- **App issue / question / feature request:** Ashley Brown — abrown@pharmacyinnovations.net
- **Can't sign in / wrong location assigned:** Ashley Brown
- **Question about a specific transfer:** use the **❓ Ask question** button on the transfer — routes to the right pharmacy's Teams chat

---

## What to Read Next

- Click 📖 **Help** in the app navbar — the full guide has step-by-step for every feature, printable as PDF
- Skim the **🆕 What's New (August 2026)** section at the top — it covers the newest changes so you're not surprised by button changes
- Check the **📦 USP Overnight Shipping Policy** section if you handle sterile compounds (Tacrolimus/Cyclosporine ophth, oil-based injections, etc.)
