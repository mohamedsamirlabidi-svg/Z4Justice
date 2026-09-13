import os
import tempfile
from pathlib import Path

from flask import Blueprint, jsonify, request

from app.parsers.csv_parser import CsvParser
from app.parsers.excel_parser import ExcelParser
from app.parsers.pdf_parser import PdfParser

parse_bp = Blueprint("parse", __name__)

PARSERS = [ExcelParser(), PdfParser(), CsvParser()]


@parse_bp.post('/parse')
def parse_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['file']
    if not file or not file.filename:
        return jsonify({'error': 'Empty filename'}), 400

    suffix = Path(file.filename).suffix or '.tmp'
    tmp_path = None

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = tmp.name
            file.save(tmp_path)

        parser = next((p for p in PARSERS if p.can_parse(tmp_path)), None)
        if parser is None:
            return jsonify({'error': f'Unsupported format: {suffix}'}), 400

        parsed = parser.parse(tmp_path)
        payload = parsed.to_dict()
        return jsonify(payload), 200
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
