from flask import Blueprint, jsonify
from app.config import WATCH_FOLDERS

health_bp = Blueprint("health", __name__)

@health_bp.get("/health")
def health():
    return jsonify({"status": "ok", "watching": WATCH_FOLDERS})
