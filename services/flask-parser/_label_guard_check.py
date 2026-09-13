from pathlib import Path
from app.parsers.excel_parser import ExcelParser

labels = {"nom", "adresse", "date", "facture", "total", "description", "reference", "référence"}
files = list(Path(r"C:\Users\Y055R1\Downloads\Desktop\GAMESTREAM ATLAS").rglob("*.xlsx"))[:20]
parser = ExcelParser()
bad = []
ok = 0
for f in files:
    try:
        d = parser.parse(str(f)).to_dict()
        name = (d.get("client",{}).get("name") or "").strip().lower().replace(":","")
        inv = (d.get("invoiceNo") or "").strip().lower().replace(":","")
        if name in labels or inv in labels:
            bad.append((str(f), d.get("invoiceNo"), d.get("client",{}).get("name")))
        else:
            ok += 1
    except Exception as e:
        bad.append((str(f), "ERR", str(e)))

print({"tested": len(files), "ok": ok, "bad": len(bad)})
for row in bad[:5]:
    print(row)
