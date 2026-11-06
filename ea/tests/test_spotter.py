import hashlib
import io
import tarfile
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from test_local_wake import FakeEngine

from seti_ea.models import KWS_MODEL, ModelSpec, fetch, installed
from seti_ea.spotter import (
    Spotter,
    keywords_text,
    load_lexicon,
    load_spotter,
    pronunciations,
)

FIXTURES = Path(__file__).parent / "fixtures"
LEXICON = {
    "HEY": ["HH", "EY1"],
    "SETI": ["S", "EH1", "T", "IY2"],
    "COMPUTER": ["K", "AH0", "M", "P", "Y", "UW1", "T", "ER0"],
}


def test_the_lexicon_keeps_one_pronunciation_per_word(tmp_path: Path) -> None:
    path = tmp_path / "en.phone"
    path.write_text("HEY HH EY1\nSETI S EH1 T IY2\nSETI S EH1 T IY0\nEMPTY\n", encoding="utf-8")
    assert load_lexicon(path) == {"HEY": ["HH", "EY1"], "SETI": ["S", "EH1", "T", "IY2"]}


def test_a_phrase_is_spelled_in_phones_with_its_flapped_variant() -> None:
    assert pronunciations("Hey, Seti!", LEXICON) == [
        ["HH", "EY1", "S", "EH1", "T", "IY2"],
        ["HH", "EY1", "S", "EH1", "D", "IY2"],
        ["HH", "EY1", "S", "EH1", "T", "IY0"],
        ["HH", "EY1", "S", "EH1", "D", "IY0"],
    ]
    assert pronunciations("hey computer", LEXICON) == [
        ["HH", "EY1", "K", "AH0", "M", "P", "Y", "UW1", "T", "ER0"],
        ["HH", "EY1", "K", "AH0", "M", "P", "Y", "UW1", "D", "ER0"],
    ]
    assert pronunciations("hey", LEXICON) == [["HH", "EY1"]]
    assert pronunciations("Hey Zorblax", LEXICON) is None
    assert pronunciations("  ", LEXICON) is None


def test_keyword_lines_carry_the_boost_threshold_and_one_label() -> None:
    text = keywords_text([["HH", "EY1"], ["HH", "EY2"]])
    assert text == "HH EY1 :1.5 #0.2 @wake/HH EY2 :1.5 #0.2 @wake"


def test_a_spotter_cannot_listen_for_a_word_it_cannot_spell() -> None:
    engine = FakeEngine()
    spotter = Spotter(engine, LEXICON)
    assert spotter.listener("Hey Zorblax") is None
    assert engine.streams == []
    assert spotter.listener("Hey Seti") is not None
    assert len(engine.streams) == 1


def archive_of(spec_name: str, files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:bz2") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(f"{spec_name}/{name}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def test_the_model_is_fetched_once_checked_and_unpacked_outside_the_repo(tmp_path: Path) -> None:
    data = archive_of("m", {"a.txt": b"a", "b.onnx": b"b", "extra.bin": b"x"})
    source = tmp_path / "m.tar.bz2"
    source.write_bytes(data)
    spec = ModelSpec("m", source.as_uri(), hashlib.sha256(data).hexdigest(), ("a.txt", "b.onnx"))
    root = tmp_path / "cache"
    assert installed(spec, root) is None
    path = fetch(spec, root)
    assert sorted(p.name for p in path.iterdir()) == ["a.txt", "b.onnx"]
    assert installed(spec, root) == path
    source.unlink()
    assert fetch(spec, root) == path


def test_a_download_that_fails_its_checksum_is_refused(tmp_path: Path) -> None:
    source = tmp_path / "m.tar.bz2"
    source.write_bytes(archive_of("m", {"a.txt": b"a"}))
    spec = ModelSpec("m", source.as_uri(), "0" * 64, ("a.txt",))
    with pytest.raises(OSError, match="checksum"):
        fetch(spec, tmp_path / "cache")
    assert installed(spec, tmp_path / "cache") is None


def spot(spotter: Spotter, phrase: str, name: str) -> list[float]:
    audio, rate = sf.read(FIXTURES / name, dtype="float32")
    listener = spotter.listener(phrase)
    assert listener is not None
    step = rate // 10
    return [
        (i + step) / rate
        for i in range(0, len(audio), step)
        if listener.feed(np.ascontiguousarray(audio[i : i + step]), rate)
    ]


@pytest.mark.skipif(installed(KWS_MODEL) is None, reason="run python -m seti_ea.models to fetch the model")
def test_the_real_model_hears_the_phrase_and_nothing_else() -> None:
    model = installed(KWS_MODEL)
    assert model is not None
    spotter = load_spotter(model)
    hits = spot(spotter, "Hey Seti", "hey-seti-what-is-running.wav")
    assert len(hits) == 1
    assert 0.5 < hits[0] < 1.8
    assert spot(spotter, "Hey Seti", "what-is-running.wav") == []
    assert spot(spotter, "OK Computer", "hey-seti-what-is-running.wav") == []
