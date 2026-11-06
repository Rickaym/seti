"""The on-host wake word model: fetched once into a cache outside the repo, checked by hash."""

import hashlib
import os
import shutil
import tarfile
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from loguru import logger

MODEL_DIR_ENV = "SETI_EA_MODEL_DIR"
DOWNLOAD_TIMEOUT_SECS = 120


@dataclass(frozen=True)
class ModelSpec:
    """A release archive and the files the EA keeps from it."""

    name: str
    url: str
    sha256: str
    files: tuple[str, ...]


KWS_STEM = "epoch-13-avg-2-chunk-16-left-64"
KWS_MODEL = ModelSpec(
    name="sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20",
    url="https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/"
    "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2",
    sha256="68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6",
    files=(
        "tokens.txt",
        "en.phone",
        f"encoder-{KWS_STEM}.int8.onnx",
        f"decoder-{KWS_STEM}.onnx",
        f"joiner-{KWS_STEM}.int8.onnx",
    ),
)


def models_root() -> Path:
    """SETI_EA_MODEL_DIR, else the user's cache: never inside the checkout."""
    configured = os.environ.get(MODEL_DIR_ENV, "").strip()
    if configured != "":
        return Path(configured).expanduser()
    cache = os.environ.get("XDG_CACHE_HOME", "").strip()
    return (Path(cache) if cache != "" else Path.home() / ".cache") / "seti-ea" / "models"


def model_path(spec: ModelSpec, root: Path | None = None) -> Path:
    return (root or models_root()) / spec.name


def installed(spec: ModelSpec, root: Path | None = None) -> Path | None:
    """The model's directory when every file it needs is there, else None."""
    path = model_path(spec, root)
    return path if all((path / name).is_file() for name in spec.files) else None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _extract(archive: Path, spec: ModelSpec, target: Path) -> None:
    wanted = {f"{spec.name}/{name}": name for name in spec.files}
    with tarfile.open(archive, "r:bz2") as tar:
        for member in tar.getmembers():
            name = wanted.get(member.name)
            if name is None or not member.isfile():
                continue
            source = tar.extractfile(member)
            if source is None:
                continue
            with source, (target / name).open("wb") as out:
                shutil.copyfileobj(source, out)


def fetch(spec: ModelSpec, root: Path | None = None) -> Path:
    """Downloads, verifies and unpacks the model unless it is already there; returns its directory."""
    ready = installed(spec, root)
    if ready is not None:
        return ready
    path = model_path(spec, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    logger.info(f"Fetching the wake word model {spec.name} into {path.parent}")
    with tempfile.TemporaryDirectory(dir=path.parent) as scratch:
        archive = Path(scratch) / "model.tar.bz2"
        with (
            urllib.request.urlopen(spec.url, timeout=DOWNLOAD_TIMEOUT_SECS) as response,
            archive.open("wb") as out,
        ):
            shutil.copyfileobj(response, out)
        if _sha256(archive) != spec.sha256:
            raise OSError(f"The wake word model download from {spec.url} failed its checksum")
        staged = Path(scratch) / spec.name
        staged.mkdir()
        _extract(archive, spec, staged)
        missing = [name for name in spec.files if not (staged / name).is_file()]
        if missing:
            raise OSError(f"The wake word model archive lacks {', '.join(missing)}")
        shutil.rmtree(path, ignore_errors=True)
        staged.rename(path)
    return path


def main() -> None:
    """Fetches the wake word model at install time: `uv run --project ea python -m seti_ea.models`."""
    print(fetch(KWS_MODEL))


if __name__ == "__main__":
    main()
