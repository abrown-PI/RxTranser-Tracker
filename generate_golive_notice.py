from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
import os

doc = Document()

for section in doc.sections:
    section.top_margin = Cm(2)
    section.bottom_margin = Cm(2)
    section.left_margin = Cm(2.5)
    section.right_margin = Cm(2.5)

style = doc.styles['Normal']
style.font.name = 'Calibri'
style.font.size = Pt(11)
style.font.color.rgb = RGBColor(0x1e, 0x29, 0x3b)

for level in range(1, 4):
    h = doc.styles[f'Heading {level}']
    h.font.name = 'Calibri'
    h.font.color.rgb = RGBColor(0x17, 0x2a, 0x4f)
    h.font.bold = True
    if level == 1:
        h.font.size = Pt(20)
    elif level == 2:
        h.font.size = Pt(14)
    else:
        h.font.size = Pt(12)

GRAY = RGBColor(0x47, 0x55, 0x69)

def body(text, bold=False, space=6):
    p = doc.add_paragraph()
    r = p.add_run(text)
    r.bold = bold
    p.paragraph_format.space_after = Pt(space)
    return p

def mixed(*parts):
    """parts: list of (text, bold_bool) tuples"""
    p = doc.add_paragraph()
    for text, bold in parts:
        r = p.add_run(text)
        r.bold = bold
    p.paragraph_format.space_after = Pt(6)
    return p

def bullet(text, bold_prefix=None):
    p = doc.add_paragraph(style='List Bullet')
    if bold_prefix:
        r = p.add_run(bold_prefix)
        r.bold = True
        p.add_run(text)
    else:
        p.add_run(text)

def numbered(text, bold_prefix=None):
    p = doc.add_paragraph(style='List Number')
    if bold_prefix:
        r = p.add_run(bold_prefix)
        r.bold = True
        p.add_run(text)
    else:
        p.add_run(text)

# ===== TITLE =====
h = doc.add_heading('Transfer Tracker Go-Live — Acknowledgment & Sign-Off', level=1)

intro = doc.add_paragraph()
r = intro.add_run('Please read this in full, then sign at the bottom to confirm you understand.')
r.italic = True
intro.paragraph_format.space_after = Pt(4)

header = doc.add_paragraph()
r = header.add_run('Pharmacy Innovations  •  PI Transfer Tracker  •  Version 1.0')
r.font.size = Pt(10)
r.font.color.rgb = GRAY
header.paragraph_format.space_after = Pt(12)

# Fillable location/date
mixed(('Location: ', True), ('__________________________', False))
mixed(('Go-live (transfer) date: ', True), ('__________________________', False))
doc.add_paragraph()

# Overview
body(
    'Your location goes live on the PI Transfer Tracker on the date above. From that point forward, all inter-pharmacy transfers, sterile compound shipments from Erie, and pickup orders are entered, tracked, and received through the portal. The old transfer spreadsheet is no longer used.'
)

mixed(('Website: ', True), ('https://red-island-0bb34e510.7.azurestaticapps.net', False))
mixed(('Sign in with: ', True), ('your @pharmacyinnovations.net Microsoft 365 account (same one you use for Outlook / Teams)', False))
doc.add_paragraph()

# ===== 1 =====
doc.add_heading('1. All transfers go in the portal — no more spreadsheet', level=2)
body('Starting the go-live date, every transfer between pharmacies is submitted through the portal. This includes:')
bullet('Prescriptions your pharmacy is sending to another PI store to fill (compounds → Erie, commercial → another PI store)')
bullet('Pickup orders being routed to another pharmacy')
bullet('Refills of previously-transferred prescriptions — use the ', bold_prefix='+ Refill')
p = doc.paragraphs[-1]
p.add_run(' button, ')
r = p.add_run('do not')
r.bold = True
p.add_run(' use + New Transfer for a refill (breaks the Rx history chain)')
mixed(('The transfer spreadsheet is retired.', True), (' Do not add new rows after your go-live date.', False))

# ===== 2 =====
doc.add_heading('2. Receive shipments through the portal', level=2)
body('When a box arrives from another pharmacy:')
numbered('Focus the 📷 Scan tracking barcode field at the top of the Shipments tab')
numbered('Scan the FedEx barcode OR the barcode on the bulk packing slip inside the box')
numbered('Click 📦 Arrived at my pharmacy, unpack, check off each Rx as you go')
numbered('Click Mark Package Received')
mixed(
    ('Scripts missing from the box? ', True),
    ('Use ', False), ('Receive Partial', True),
    (' instead and only check what you actually have. Anything unchecked flags as missing and notifies the fill pharmacy — a fully-missing patient auto-goes back on the fill queue.', False),
)

# ===== 3 =====
doc.add_heading('3. Questions on a transfer route through Teams', level=2)
body(
    'When you need info from another pharmacy about a specific transfer, click ❓ Ask question on that transfer. Your question lands in the other pharmacy’s Teams chat. Their reply comes back in the transfer’s Discussion section.'
)
body('No more calling around — every question and answer is captured on the transfer record.')

# ===== 4 =====
doc.add_heading('4. Shipping (fill-side techs)', level=2)
mixed(
    ('You do NOT type FedEx tracking numbers into the app.', True),
    (' When you generate the FedEx label in WorldShip, type either:', False),
)
bullet('for patient direct ships', bold_prefix='The Transfer ID — ')
bullet('for pharmacy-to-pharmacy boxes (e.g., BULK-2026-0142)', bold_prefix='The BULK Shipment ID — ')
body('…into WorldShip’s Customer Reference field. FedEx tracking, ship date, and delivery status flow back to the app automatically.')

# ===== 5 =====
doc.add_heading('5. Training materials (attached)', level=2)
bullet('the day-one walkthrough', bold_prefix='Getting Started Guide (PI-Transfer-Tracker-Getting-Started.docx) — ')
bullet('the full 20-page reference (also available inside the app under 📖 Help)', bold_prefix='How To Use Reference (PI-Transfer-Tracker-How-To-Use.pdf) — ')
bullet('screen-recorded walkthrough of the most common tasks', bold_prefix='Training Video (Transfer Tracker.webm) — ')
mixed(
    ('The ', False), ('🆕 What’s New', True),
    (' section on the app’s ', False), ('📖 Help', True),
    (' page tracks any changes since these docs were written — check it periodically so you’re not surprised by button/label changes.', False),
)

# ===== 6 =====
doc.add_heading('6. Questions, feedback & support', level=2)
bullet('Ashley Brown (abrown@pharmacyinnovations.net)', bold_prefix='App issue / question / feature request — ')
bullet('use the ❓ Ask question button on the transfer — routes to the right pharmacy’s Teams chat', bold_prefix='Question about a specific transfer once you’re using it — ')
doc.add_paragraph()

note = doc.add_paragraph()
r = note.add_run('A note on updates:  ')
r.bold = True
note.add_run(
    'PI Transfer Tracker is actively being built out, so new features and refinements will roll out over time. If something doesn’t work the way you expect, don’t work around it quietly — let Ashley know so it can be fixed. Your feedback is exactly what drives the fixes and shapes what gets built next.'
)

# ===== ACKNOWLEDGMENT =====
doc.add_paragraph()
doc.add_heading('Acknowledgment', level=2)
body(
    'By signing below, I confirm that I have read and understand this notice. I understand that as of the go-live (transfer) date, all inter-pharmacy transfers are entered, tracked, and received through the PI Transfer Tracker portal, and that the old transfer spreadsheet is no longer used.'
)
doc.add_paragraph()

# Signature block
def sig_line(label):
    p = doc.add_paragraph()
    p.add_run('_' * 50 + '   ')
    r = p.add_run(label)
    r.font.size = Pt(10)
    r.font.color.rgb = GRAY

sig_line('Printed Name')
sig_line('Signature')
sig_line('Date')

# Save
out_dir = '/mnt/c/Users/ABrown/OneDrive - Pharmacy Innovations/Documents/Portals/Transfer Tracker'
os.makedirs(out_dir, exist_ok=True)
out_path = os.path.join(out_dir, 'Transfer-Tracker-Go-Live-Notice.docx')
doc.save(out_path)
print(f'Saved to: {out_path}')
