import logging
from flask import Flask
from app.config import FLASK_PORT, LOG_LEVEL, BACKFILL_ON_START
from app.watcher import wait_for_backend, backfill, start_watcher
from app.queue_manager import start_worker
from routes.health import health_bp
from routes.trigger import trigger_bp
from routes.parse import parse_bp

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.register_blueprint(health_bp)
app.register_blueprint(trigger_bp)
app.register_blueprint(parse_bp)

if __name__ == "__main__":
    logger.info("🚀 Flask Invoice Parser starting...")
    start_worker()
    wait_for_backend(timeout_sec=60)
    if BACKFILL_ON_START:
        backfill()
    start_watcher()
    app.run(host="0.0.0.0", port=FLASK_PORT)
