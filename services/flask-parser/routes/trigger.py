from flask import Blueprint, request, jsonify
from app.queue_manager import _process

trigger_bp = Blueprint("trigger", __name__)

@trigger_bp.post('/trigger')
def trigger():
    data = request.get_json(force=True)
    path = data.get('path')
    if not path:
        return jsonify({'error': 'path required'}), 400
    try:
        _process(path)
        return jsonify({'status': 'processed', 'path': path})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
