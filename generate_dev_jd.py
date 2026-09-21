"""Generate a Full-Stack Senior Software Engineer JD docx for Pharmacy Innovations.
Matches the ReComRx doc style (logo header, Calibri, PI blue accents).
"""
from docx import Document
from docx.shared import Pt, Cm, RGBColor, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH
import os

LOGO_PATH = '/mnt/c/Users/ABrown/OneDrive - Pharmacy Innovations/Documents/Tina/Flyers/Pharmacy Innovations landscape logo.png'

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

def body(text, bold=False):
    p = doc.add_paragraph()
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

# ==== LOGO ====
logo_para = doc.add_paragraph()
logo_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
logo_run = logo_para.add_run()
logo_run.add_picture(LOGO_PATH, width=Inches(2.5))

# ==== TITLE ====
h = doc.add_heading('Full-Stack Software Developer', level=1)

sub = doc.add_paragraph()
r = sub.add_run('Pharmacy Innovations  •  Remote-friendly (Denton, TX preferred)')
r.font.size = Pt(11)
r.font.color.rgb = GRAY
r.italic = True
sub.paragraph_format.space_after = Pt(12)

# ==== ABOUT US ====
doc.add_heading('About us', level=2)
body(
    'Pharmacy Innovations is an 11-location compounding pharmacy network across PA, NY, VA, TX, FL, SC, and AZ, plus a growing suite of DTC brands (OpalRx, and more in the pipeline). We are building an in-house software ecosystem to replace our vendor stack across pharmacy management, patient care, ordering, licensing, training, transfer tracking, POS, DSCSA compliance, and analytics.'
)

# ==== ABOUT THE ROLE ====
doc.add_heading('About the role', level=2)
body(
    'This role is a working-developer position on our small internal software team. You will help build, maintain, and extend our portfolio of in-house portals and tools, and contribute to a larger pharmacy management platform (currently vendor-built) that we are bringing in-house. Day-to-day is a mix of shipping new features, fixing bugs, adding integrations, and helping migrate work off outside vendors.'
)
body(
    'You will work directly with our internal architect who owns the roadmap and design decisions. Your focus is executing well and shipping.'
)

# ==== STACK ====
doc.add_heading('Stack', level=2)
bullet('React, TypeScript, and vanilla HTML SPAs when that is the right tool for the job', bold_prefix='Frontend — ')
bullet('Node.js / TypeScript on Azure Functions; .NET 8 with EF Core + PostgreSQL for a couple of the larger apps', bold_prefix='Backend — ')
bullet('PostgreSQL, Azure Cosmos DB, Azure Table Storage, SQLite for lightweight tools', bold_prefix='Data — ')
bullet('Azure Static Web Apps + Azure Functions (managed and standalone), plus some Vercel + Supabase for standalone brands', bold_prefix='Hosting — ')
bullet('MSAL / Entra ID / Microsoft Graph across the internal apps', bold_prefix='Auth — ')
bullet('Microsoft 365 (Graph, SharePoint, Teams, Outlook), Shopify, WooCommerce / WordPress, Salesforce, NetSuite, PK Software, Tabz / HealNow, FedEx APIs', bold_prefix='Integrations — ')
bullet('Claude API for extraction, agentic workflows, and internal tooling', bold_prefix='AI — ')

# ==== WHO YOU ARE ====
doc.add_heading('Who you are', level=2)
bullet('Mid-level full-stack developer (roughly 2-5 years of experience) who is comfortable working across the stack')
bullet('Solid TypeScript + React, plus at least one backend language you have shipped with (Node, .NET, Python, Go)')
bullet('Comfortable with SQL and picking up NoSQL / key-value stores as needed')
bullet('Have worked on real production apps — not just tutorials or side projects')
bullet('Willing to jump between projects — the portfolio is broad and priorities shift')
bullet('Good written communicator — most of our collaboration is async')

body('Bonus if you have any of the following:', bold=True)
bullet('Experience with Azure Functions and Static Web Apps')
bullet('Healthcare or pharmacy experience (HIPAA awareness, PMS integrations, compounding workflows)')
bullet('WordPress / WooCommerce work, or Shopify apps')
bullet('MSAL + Microsoft Graph / SharePoint integration')
bullet('LLM integration work (Claude, OpenAI, structured extraction)')
bullet('Experience picking up an unfamiliar codebase and shipping in it quickly (relevant for the vendor-built platform takeover)')

# ==== LOGISTICS ====
doc.add_heading('Location and logistics', level=2)
bullet('we have a pharmacy location there and would love an in-person option', bold_prefix='Denton, TX preferred — ')
bullet('for the right candidate', bold_prefix='Remote-friendly — ')
bullet('part-time, contract, or full-time all on the table depending on fit', bold_prefix='Engagement — ')
bullet('will move on the right person; we can start on a project scope while we get to know each other', bold_prefix='Start date — ')

# ==== HOW TO APPLY ====
doc.add_heading('How to apply', level=2)
body('Reach out to Ashley Brown — abrown@pharmacyinnovations.net — with:')
bullet('A quick intro and what you are looking for')
bullet('Links to production work (portfolio, GitHub, LinkedIn — whatever you have)')
bullet('A rough hourly rate or salary range so we can make sure we are aligned')

body(
    'We will follow up within a couple of days with a call to talk through the projects, walk through some of what we have already shipped, and see if it is a fit.'
)

# ==== FOOTER ====
doc.add_paragraph()
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run('Pharmacy Innovations  •  pharmacyinnovations.net')
r.font.size = Pt(10)
r.font.color.rgb = GRAY
r.italic = True

# Save
out_dir = '/mnt/c/Users/ABrown/OneDrive - Pharmacy Innovations/Documents/Hiring'
os.makedirs(out_dir, exist_ok=True)
out_path = os.path.join(out_dir, 'PI-Full-Stack-Developer-JD.docx')
doc.save(out_path)
print(f'Saved to: {out_path}')
