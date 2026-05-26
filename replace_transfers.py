import re

with open(r'\\wsl.localhost\Ubuntu\home\abrown\transfer-tracker\index.html', 'r', encoding='utf-8') as f:
    content = f.read()

start_marker = 'let TRANSFERS = ['
start_idx = content.index(start_marker)

# Find matching ];
depth = 0
in_string = None
i = start_idx + len('let TRANSFERS = ')
prev = ''
end_idx = None

for i in range(start_idx + len('let TRANSFERS = '), len(content)):
    c = content[i]

    if in_string:
        if c == in_string and prev != '\\':
            in_string = None
        prev = c
        continue

    if c in ("'", '"', '`'):
        in_string = c
        prev = c
        continue

    if c == '[':
        depth += 1
    elif c == ']':
        depth -= 1
        if depth == 0:
            end_idx = i + 1
            if end_idx < len(content) and content[end_idx] == ';':
                end_idx += 1
            break
    prev = c

if end_idx is None:
    print('ERROR: Could not find end of TRANSFERS array')
    exit(1)

replacement = """let TRANSFERS = (typeof IMPORT_DATA !== 'undefined' ? IMPORT_DATA : []).map(d => ({
  id: d.id,
  patientName: d.patientName, patientDOB: '', patientAllergies: 'NKA',
  originLocation: d.originLocation, fillLocation: d.fillLocation,
  shipTo: d.shipTo, deliveryCharge: '',
  shipAddr1: '', shipAddr2: '', shipCity: '', shipState: '', shipZip: '',
  billing: (d.paid === 'HealNow' || d.paid === 'Healnow') ? 'HealNow' : (d.paid === 'Credit Card' || d.paid === 'CC') ? 'CreditCard' : (d.paid === 'Pay at Store' || d.paid === 'Pay In Store') ? 'PayInStore' : 'HealNow',
  ccOnFileInPaladin: false,
  semaDrAuthorized: d.semaDrAuthorized || 'NA',
  txEmailedDate: d.txEmailedDate, dateReceivedAtErie: d.dateReceivedAtErie,
  patientStatus: d.patientStatus || 'Pending', coldItem: d.coldItem,
  anticipatedShipDate: d.anticipatedShipDate, dateShipped: d.dateShipped,
  trackingNumber: d.trackingNumber || '', paid: d.paid || 'Pending',
  dateReceivedByPatient: d.dateReceivedByPatient,
  status: d.status,
  submittedBy: d.originLocation + ' Tech', assignedTo: d.dateReceivedAtErie ? 'Erie Sterile' : null,
  createdAt: d.createdAt,
  pkSheet: null, formula: null, hardCopy: null,
  items: [mkItem(d.id * 10, d.drug || '', d.qty || '', '', '', '', d.status === 'Delivered' || d.status === 'Shipped')],
  comments: []
}));"""

new_content = content[:start_idx] + replacement + content[end_idx:]

with open(r'\\wsl.localhost\Ubuntu\home\abrown\transfer-tracker\index.html', 'w', encoding='utf-8') as f:
    f.write(new_content)

print(f'Replaced TRANSFERS array (chars {start_idx}-{end_idx}) with IMPORT_DATA mapper')
