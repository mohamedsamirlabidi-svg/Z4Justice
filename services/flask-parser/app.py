from flask import Flask, request, jsonify
import logging
import os
import tempfile
from pathlib import Path

# v2 parsers (app/parsers/) - primary
from app.parsers.excel_parser import ExcelParser
from app.parsers.pdf_parser import PdfParser
from app.parsers.csv_parser import CsvParser

# v1 parsers (parser/) - fallback only
from parser.excel_parser import extract_excel
from parser.pdf_parser import extract_pdf
from parser.csv_parser import extract_csv
from parser.ai_enricher import should_use_ai, ai_enrich_invoice
from parser.sync import send_invoice
from parser.watcher import start_watcher

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)

# v2 parser instances
_excel_parser = ExcelParser()
_pdf_parser = PdfParser()
_csv_parser = CsvParser()

PARSER_MAP = {
    ".xlsx": extract_excel,
    ".xls": extract_excel,
    ".pdf": extract_pdf,
    ".csv": extract_csv,
}


def parse_with_v2(filepath: str) -> dict | None:
    """Try parsing with v2 parsers first. Returns dict or None."""
    fp = str(filepath)
    ext = Path(fp).suffix.lower()
    try:
        if ext in (".xlsx", ".xls") and _excel_parser.can_parse(fp):
            result = _excel_parser.parse(fp)
            if result.confidence and result.confidence >= 0.5:
                return result.to_dict()
        elif ext == ".pdf" and _pdf_parser.can_parse(fp):
            result = _pdf_parser.parse(fp)
            if result.confidence and result.confidence >= 0.5:
                return result.to_dict()
        elif ext == ".csv" and _csv_parser.can_parse(fp):
            result = _csv_parser.parse(fp)
            if result.confidence and result.confidence >= 0.5:
                return result.to_dict()
    except Exception as e:
        logger.warning(f"v2 parser failed for {filepath}: {e}")
    return None


def parse_and_enrich(filepath):
    """Parse a file and optionally enrich with AI if confidence is low."""
    ext = Path(filepath).suffix.lower()
    parser = PARSER_MAP.get(ext)
    if not parser:
        raise ValueError(f"Unsupported format: {ext}")

    payload = parser(str(filepath))

    # AI fallback: only if rule-based result is low quality
    if should_use_ai(payload):
        raw_text = payload.get("_raw_text", "")
        if not raw_text:
            # Try to extract raw text for AI
            try:
                import pdfplumber
                with pdfplumber.open(str(filepath)) as pdf:
                    raw_text = "\n".join(page.extract_text() or "" for page in pdf.pages)
            except Exception:
                pass

        if raw_text:
            ai_result = ai_enrich_invoice(raw_text, os.path.basename(str(filepath)))
            if ai_result:
                logger.info(f"AI enrichment applied for {filepath}")
                # Merge AI result with source file info
                ai_result["sourceFile"] = os.path.basename(str(filepath))
                ai_result["notes"] = f"Parsed by flask-parser v2 (AI enriched) | items: {len(ai_result.get('items', []))}"
                ai_result["status"] = ai_result.get("status", "pending")
                payload = ai_result

    # Remove internal raw text before sending
    payload.pop("_raw_text", None)
    return payload


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "service": "flask-parser-v2",
    }), 200


@app.route("/parse", methods=["POST"])
def parse_endpoint():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400

    temp_path = Path(tempfile.gettempdir()) / file.filename
    file.save(str(temp_path))

    try:
        # Try v2 parsers first — they return structured data directly
        v2_result = parse_with_v2(str(temp_path))
        if v2_result:
            logger.info(f"v2 parser succeeded for {file.filename}: invoiceNo={v2_result.get('invoiceNo')}")
            return jsonify(v2_result), 200

        # Fallback to v1 parsers + AI enrichment
        payload = parse_and_enrich(str(temp_path))
        return jsonify(payload), 200
    except Exception as e:
        logger.error(f"Parse error: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        if temp_path.exists():
            temp_path.unlink()


@app.route("/batch", methods=["POST"])
def batch_endpoint():
    data = request.get_json()
    directory = data.get("directory")
    if not directory or not Path(directory).exists():
        return jsonify({"error": "Invalid directory"}), 400

    from concurrent.futures import ThreadPoolExecutor, as_completed

    def process_file(path):
        try:
            payload = parse_and_enrich(str(path))
            send_invoice(payload)
            return {"file": str(path), "status": "ok"}
        except Exception as e:
            logger.error(f"Batch error {path}: {e}")
            return {"file": str(path), "status": "error", "message": str(e)}

    files = [p for p in Path(directory).rglob("*")
             if p.is_file() and p.suffix.lower() in PARSER_MAP]
    results = []
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {executor.submit(process_file, f): f for f in files}
        for future in as_completed(futures):
            results.append(future.result())

    return jsonify({"processed": len(results), "results": results}), 200


@app.route("/stats")
def stats():
    return jsonify({"service": "flask-parser-v2"})


if __name__ == "__main__":
    import threading
    watcher_thread = threading.Thread(target=start_watcher, daemon=True)
    watcher_thread.start()
    port = int(os.getenv("FLASK_PORT", "5100"))
    logger.info(f"Starting Flask parser v2 on port {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
