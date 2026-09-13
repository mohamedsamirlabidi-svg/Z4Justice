from .utils import is_label
WEIGHTS={"invoiceNo":0.35,"dateRaw":0.30,"totalRaw":0.25,"client":0.10}
def score_confidence(invoice_no,date_raw,total_raw,client):
    values={"invoiceNo":invoice_no,"dateRaw":date_raw,"totalRaw":total_raw,"client":client}
    score=0.0
    for field,weight in WEIGHTS.items():
        val=values[field]
        if val and not is_label(str(val)): score+=weight
    return round(score,3)
