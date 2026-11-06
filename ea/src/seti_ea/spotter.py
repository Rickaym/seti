"""Hears the wake phrase on this host with a small keyword spotter, so sleep costs no transcription."""

import asyncio
import re
import tempfile
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Protocol

import numpy as np
import numpy.typing as npt
from loguru import logger

from seti_ea.models import KWS_MODEL, KWS_STEM, fetch

BOOST = 1.5
THRESHOLD = 0.2
TRAILING_BLANKS = 1
ACTIVE_PATHS = 8
VOWEL = re.compile(r"^[A-Z]{2}[0-2]$")

Samples = npt.NDArray[np.float32]


def load_lexicon(path: Path) -> dict[str, list[str]]:
    """Word to phones from the model's lexicon, one pronunciation per word."""
    lexicon: dict[str, list[str]] = {}
    with path.open(encoding="utf-8") as f:
        for line in f:
            word, *phones = line.split()
            if phones:
                lexicon.setdefault(word, phones)
    return lexicon


def _flapped(phones: list[str]) -> list[str]:
    """American English says a T between a vowel and a weak vowel as a quick D: Seti as Seddy."""
    out = list(phones)
    for i in range(1, len(out) - 1):
        after = out[i + 1]
        if out[i] == "T" and VOWEL.match(out[i - 1]) and VOWEL.match(after) and not after.endswith("1"):
            out[i] = "D"
    return out


def phrase_words(phrase: str) -> list[str]:
    return re.sub(r"[^\w\s']", " ", phrase).upper().split()


def _unstressed(phones: list[str]) -> list[str]:
    """A vowel the lexicon marks with secondary stress is often said without: Seti ends like city."""
    return [f"{phone[:-1]}0" if VOWEL.match(phone) and phone.endswith("2") else phone for phone in phones]


def pronunciations(phrase: str, lexicon: Mapping[str, list[str]]) -> list[list[str]] | None:
    """The phrase in the model's phones with its common variants; None when a word is unknown."""
    words = phrase_words(phrase)
    if not words:
        return None
    phones: list[str] = []
    for word in words:
        known = lexicon.get(word)
        if known is None:
            return None
        phones.extend(known)
    variants: list[list[str]] = []
    for spoken in (phones, _unstressed(phones)):
        for variant in (spoken, _flapped(spoken)):
            if variant not in variants:
                variants.append(variant)
    return variants


def keywords_text(variants: Iterable[list[str]]) -> str:
    """sherpa-onnx keyword lines for one stream, joined by the slash it splits them on."""
    return "/".join(f"{' '.join(phones)} :{BOOST} #{THRESHOLD} @wake" for phones in variants)


class KwsStream(Protocol):
    def accept_waveform(self, sample_rate: int, waveform: Samples) -> None: ...


class KwsEngine(Protocol):
    """The part of sherpa_onnx.KeywordSpotter the spotter uses, so tests can stand in for it."""

    def create_stream(self, keywords: str | None = None) -> KwsStream: ...
    def is_ready(self, stream: KwsStream, /) -> bool: ...
    def decode_stream(self, stream: KwsStream, /) -> None: ...
    def get_result(self, stream: KwsStream, /) -> str: ...
    def reset_stream(self, stream: KwsStream, /) -> None: ...


class Listener:
    """One stream listening for one phrase; not thread safe, so one worker feeds it."""

    def __init__(self, engine: KwsEngine, keywords: str) -> None:
        self._engine = engine
        self._stream = engine.create_stream(keywords)

    def feed(self, samples: Samples, sample_rate: int) -> bool:
        """True when the phrase ended in these samples."""
        self._stream.accept_waveform(sample_rate, samples)
        heard = False
        while self._engine.is_ready(self._stream):
            self._engine.decode_stream(self._stream)
            if self._engine.get_result(self._stream):
                heard = True
                self._engine.reset_stream(self._stream)
        return heard


class Spotter:
    """The keyword spotter model, loaded once per process; each call listens with its own stream."""

    def __init__(self, engine: KwsEngine, lexicon: Mapping[str, list[str]]) -> None:
        self._engine = engine
        self._lexicon = lexicon

    def listener(self, phrase: str) -> Listener | None:
        """A stream for the phrase, or None when the model cannot spell one of its words."""
        variants = pronunciations(phrase, self._lexicon)
        if variants is None:
            logger.warning(f'The wake phrase "{phrase}" has a word the local spotter does not know')
            return None
        return Listener(self._engine, keywords_text(variants))


def load_spotter(root: Path, threads: int = 1) -> Spotter:
    """Loads the model from its directory.

    The constructor wants a keywords file, whose keywords every stream also hears, so it gets one
    no speech can reach: nothing but ZH, needing a certainty above one.
    """
    import sherpa_onnx

    lexicon = load_lexicon(root / "en.phone")
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(f"{' '.join(['ZH'] * 8)} :0.0 #1.0 @never\n")
        seed_file = f.name
    try:
        engine = sherpa_onnx.KeywordSpotter(
            tokens=str(root / "tokens.txt"),
            encoder=str(root / f"encoder-{KWS_STEM}.int8.onnx"),
            decoder=str(root / f"decoder-{KWS_STEM}.onnx"),
            joiner=str(root / f"joiner-{KWS_STEM}.int8.onnx"),
            keywords_file=seed_file,
            num_threads=threads,
            keywords_score=BOOST,
            keywords_threshold=THRESHOLD,
            num_trailing_blanks=TRAILING_BLANKS,
            max_active_paths=ACTIVE_PATHS,
        )
    finally:
        Path(seed_file).unlink(missing_ok=True)
    logger.info(f"Local wake word spotter loaded from {root.name}")
    return Spotter(engine, lexicon)


class SharedSpotter:
    """The process's spotter: None until its model is fetched and loaded, or if that failed."""

    def __init__(self) -> None:
        self._spotter: Spotter | None = None

    def get(self) -> Spotter | None:
        return self._spotter

    async def load(self) -> None:
        """Fetches the model on first start and loads it; without it, sleep keeps speech to text on."""
        try:
            root = await asyncio.to_thread(fetch, KWS_MODEL)
            self._spotter = await asyncio.to_thread(load_spotter, root)
        except Exception as e:
            logger.warning(f"No local wake word spotter, so sleep keeps speech to text on: {e}")


LOCAL_SPOTTER = SharedSpotter()
