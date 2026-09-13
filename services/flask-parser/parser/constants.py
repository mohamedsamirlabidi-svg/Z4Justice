import re
RE_INVOICE_NO  = re.compile(r'(?:invoice|facture|inv|ref|n°|no)[^\w]*([\w\-/]+)', re.I)
RE_DATE        = re.compile(r'\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{2}[./-]\d{2})\b')
RE_AMOUNT      = re.compile(r'[\d\s]+[.,]\d{1,2}')
RE_CURRENCY    = re.compile(r'\b(EUR|USD|TND|MAD|DZD|GBP|€|\$|DT)\b', re.I)
RE_VAT         = re.compile(r'(?:tva|vat|tax|t\.v\.a)[^\d]*([\d.,\s]+%?)', re.I)
RE_LABEL_STRIP = re.compile(r'^[A-Za-zÀ-ÿ\s:/.()]+$')
RE_DATETIME    = re.compile(r'\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}')
LABEL_BLOCKLIST = {
    "nom","date","total","montant","client","facture","numéro","référence",
    "description","designation","article","libellé","quantité","prix","tva",
    "ht","ttc","adresse","société","raison sociale","net à payer","montant ttc",
    "montant ht","total ttc","total ht","date d'émission","date facture",
    "n° facture","facture n°","ref","objet","name","invoice","number",
    "reference","amount","total amount","quantity","unit price","tax",
    "subtotal","grand total","company","address","bill to","ship to",
    "due date","invoice date","invoice no","invoice #","item","product",
    "service","الاسم","التاريخ","المبلغ","العميل","الفاتورة",
    "رقم الفاتورة","ضريبة","المجموع",
}
INVOICE_LABELS = ["invoice no","facture n°","facture  n°","numéro","n° facture","n°facture","ref","invoice #","رقم الفاتورة"]
DATE_LABELS    = ["date","date facture","invoice date","date d'émission","date:","تاريخ"]
TOTAL_LABELS   = ["total ttc","total t.t.c","total t.t.c.","total","montant ttc","net à payer","grand total","amount due","المبلغ الإجمالي"]
CLIENT_LABELS  = ["client","customer","nom","nom:","raison sociale","société","company","العميل"]
VAT_LABELS     = ["tva","t.v.a","t.v.a.","t.v.a 19%","vat","tax","montant tva","ضريبة"]
HT_LABELS      = ["total ht","total h.t","total h.t.","subtotal","net ht","montant ht","amount excl"]
ITEM_HEADERS   = ["designation","description","article","libellé","qty","qté","quantité","quantity","nombre","prix","price","unit price","p.u","p.u.","montant"]
TOTAL_ANCHORS  = ["total ttc","net à payer","grand total","amount due","total amount","montant total","net a payer"]
CLIENT_ANCHORS = ["client:","customer:","bill to:","facturer à:","nom:","raison sociale:","société:"]
DATE_FORMATS   = ["%d/%m/%Y","%d-%m-%Y","%d.%m.%Y","%Y-%m-%d","%Y/%m/%d","%d/%m/%y","%d-%m-%y","%B %d, %Y","%d %B %Y","%d %b %Y"]
