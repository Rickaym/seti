"""Entry point: `uv run --project ea python -m seti_ea`."""

import sys

import uvicorn
from loguru import logger

from seti_ea.config import load_settings
from seti_ea.redact import scrubbing_sink, secrets_of
from seti_ea.server import create_app


def main() -> None:
    settings = load_settings()
    logger.remove()
    logger.add(scrubbing_sink(sys.stderr, secrets_of(settings)), level="INFO", colorize=False)
    if settings.missing:
        logger.warning(f"EA not configured, missing: {', '.join(settings.missing)}")
    logger.info(f"EA listening on 127.0.0.1:{settings.port} with model {settings.model}")
    uvicorn.run(create_app(settings), host="127.0.0.1", port=settings.port, log_level="warning")


if __name__ == "__main__":
    main()
