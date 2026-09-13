import pandas as pd
from .utils import extract_invoice_no,extract_date,extract_total,extract_client,parse_number
from .payload_builder import build_payload
def extract_csv(path):
    df=pd.read_csv(path)
    text=df.to_string()
    invoice_no=extract_invoice_no(text)
    date_raw=extract_date(text)
    total_raw=extract_total(text)
    client=extract_client(text)
    vat_raw=None
    ht_raw=None
    items=[]
    if "description" in df.columns and "quantity" in df.columns:
        for _,row in df.iterrows():
            desc=str(row.get("description","")).strip()
            if desc:
                items.append({
                    "description":desc,
                    "quantity":parse_number(row.get("quantity",1)),
                    "unitPrice":parse_number(row.get("unitPrice",0)),
                    "totalPrice":parse_number(row.get("totalPrice",0))
                })
    return build_payload(invoice_no=invoice_no,date_raw=date_raw,total_raw=total_raw,
        client=client,vat_raw=vat_raw,ht_raw=ht_raw,items=items,
        source_path=path,extraction_method="csv_pandas",raw_text=text)
