"""Quick test: verify TVA extraction matches file values."""
import sys, glob, openpyxl
sys.path.insert(0, '.')
from app.parsers.excel_parser import ExcelParser
from app.parsers.pdf_parser import PdfParser

ep = ExcelParser()
pp = PdfParser()

# --- EXCEL ---
print("=== EXCEL FILES ===")
files = glob.glob(r'C:\Users\Y055R1\Documents\GitHub\FactureERM\ACROBATE SOLUTION\2025\facture\*.xlsx')
files += glob.glob(r'C:\Users\Y055R1\Documents\GitHub\FactureERM\ACROBATE SOLUTION\2026\**\*.xlsx', recursive=True)
files += glob.glob(r'C:\Users\Y055R1\Documents\GitHub\FactureERM\GAMESTREAM ATLAS\2025\FACTURE\*.xlsx')
files += glob.glob(r'C:\Users\Y055R1\Documents\GitHub\FactureERM\GAMESTREAM ATLAS\2025\devis\*.xlsx')
files += glob.glob(r'C:\Users\Y055R1\Documents\GitHub\FactureERM\GAMESTREAM ATLAS\2026\**\*.xlsx', recursive=True)

mismatched = 0
total = 0
for f in files:
    short = f.split('FactureERM\\')[1]
    r = ep.parse(f)
    d = r.to_dict()
    ht = d['totalHT']
    tva = d['taxAmount']
    rate = d['taxRate']
    timbre = d['timbreFiscal']
    ttc = d['totalAmount']

    # Get raw file values
    raw_ttc = raw_ht = raw_tva_amount = None
    try:
        wb = openpyxl.load_workbook(f, data_only=True)
        ws = wb.active
        rows = list(ws.iter_rows(min_row=1, values_only=True))
        ht_row_idx = ttc_row_idx = None
        for row_idx, row in enumerate(rows):
            if row is None:
                continue
            for ci, cv in enumerate(row):
                if cv is None:
                    continue
                ct = str(cv).strip().lower().rstrip(':')
                if 'total h' in ct:
                    ht_row_idx = row_idx
                    for ri in range(ci + 1, min(len(row), ci + 4)):
                        if isinstance(row[ri], (int, float)):
                            raw_ht = float(row[ri])
                            break
                if 'total t' in ct:
                    ttc_row_idx = row_idx
                    for ri in range(ci + 1, min(len(row), ci + 4)):
                        if isinstance(row[ri], (int, float)):
                            raw_ttc = float(row[ri])
                            break
        # Find TVA amount between HT and TTC rows
        if ht_row_idx is not None and ttc_row_idx is not None:
            for ri in range(ht_row_idx + 1, ttc_row_idx):
                row = rows[ri] if ri < len(rows) else None
                if row is None:
                    continue
                for cv in row:
                    if isinstance(cv, (int, float)) and float(cv) > 1:
                        raw_tva_amount = float(cv)
        wb.close()
    except Exception as e:
        pass

    total += 1
    issues = []
    if raw_ht is not None and abs(raw_ht - ht) > 0.01:
        issues.append(f'HT: file={raw_ht} ext={ht}')
    if raw_ttc is not None and abs(raw_ttc - ttc) > 0.01:
        issues.append(f'TTC: file={raw_ttc} ext={ttc}')
    if raw_tva_amount is not None and abs(raw_tva_amount - tva) > 0.01:
        issues.append(f'TVA: file={raw_tva_amount} ext={tva}')

    exp_tva = round(ht * rate, 3)
    if abs(tva - exp_tva) > 0.01:
        issues.append(f'TVA_CALC: ext={tva} calc={exp_tva}')

    exp_ttc = round(ht + tva + timbre, 3)
    if abs(ttc - exp_ttc) > 0.01:
        issues.append(f'TTC_CALC: ext={ttc} calc={exp_ttc}')

    if issues:
        mismatched += 1
        print(f'ISSUE [{short}]')
        for iss in issues:
            print(f'  {iss}')
        print(f'  HT={ht} TVA={tva} rate={rate} timbre={timbre} TTC={ttc}')
        print()

print(f'Excel: {total} files, {mismatched} with issues\n')

# --- PDF ---
print("=== PDF FILES ===")
pdf_files = glob.glob(r'C:\Users\Y055R1\Documents\GitHub\FactureERM\ACROBATE SOLUTION\2025\facture\*.pdf')
pdf_files += glob.glob(r'C:\Users\Y055R1\Documents\GitHub\FactureERM\GAMESTREAM ATLAS\2025\FACTURE\*.pdf')
pdf_files += glob.glob(r'C:\Users\Y055R1\Documents\GitHub\FactureERM\GAMESTREAM ATLAS\2024\FACTURE\*.pdf')

pdf_mismatched = 0
pdf_total = 0
for f in pdf_files:
    short = f.split('FactureERM\\')[1]
    r = pp.parse(f)
    d = r.to_dict()
    ht = d['totalHT']
    tva = d['taxAmount']
    rate = d['taxRate']
    timbre = d['timbreFiscal']
    ttc = d['totalAmount']

    pdf_total += 1
    issues = []
    exp_tva = round(ht * rate, 3)
    if abs(tva - exp_tva) > 0.01:
        issues.append(f'TVA_CALC: ext={tva} calc={exp_tva}')

    exp_ttc = round(ht + tva + timbre, 3)
    if abs(ttc - exp_ttc) > 0.01:
        issues.append(f'TTC_CALC: ext={ttc} calc={exp_ttc}')

    if issues:
        pdf_mismatched += 1
        print(f'ISSUE [{short}]')
        for iss in issues:
            print(f'  {iss}')
        print(f'  HT={ht} TVA={tva} rate={rate} timbre={timbre} TTC={ttc}')
        print()

print(f'PDF: {pdf_total} files, {pdf_mismatched} with issues')
