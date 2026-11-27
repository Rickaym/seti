"""Entry point: `uv run --project ea python -m seti_ea`."""

import asyncio
import sys

import uvicorn
from loguru import logger

from seti_ea import aiortc_jitter, aiortc_opus
from seti_ea.config import load_settings
from seti_ea.llm import check_endpoint
from seti_ea.redact import scrubbing_sink, secrets_of
from seti_ea.server import create_app


def main() -> None:
    settings = load_settings()
    aiortc_opus.install()
    aiortc_jitter.install()
    logger.remove()
    logger.add(scrubbing_sink(sys.stderr, secrets_of(settings)), level="INFO", colorize=False)
    if settings.missing:
        logger.warning(f"EA not configured, missing: {', '.join(settings.missing)}")
    problem = settings.config_error or asyncio.run(check_endpoint(settings))
    if problem is not None:
        logger.error(f"EA cannot start: {problem}")
        sys.exit(1)
    logger.info(
        f"EA listening on 127.0.0.1:{settings.port} with model {settings.model} "
        f"on {settings.llm_api} at {settings.llm_host}"
    )
    uvicorn.run(create_app(settings), host="127.0.0.1", port=settings.port, log_level="warning")


if __name__ == "__main__":
    main()
