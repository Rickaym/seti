from pipecat.services.elevenlabs.tts_base import elevenlabs_language_code, language_to_elevenlabs_language
from pipecat.transcriptions.language import Language

from seti_ea.config import DEFAULT_TTS_MODEL
from seti_ea.language import (
    LANGUAGES,
    clean_language,
    find_language,
    heard_language,
    language_of,
    language_rule,
    stt_endpointing,
    stt_language,
    tts_language,
)

ONE_LANGUAGE = [code for code in LANGUAGES if code != "multi"]


def test_the_list_opens_with_english_and_multilingual() -> None:
    assert list(LANGUAGES)[:2] == ["en", "multi"]
    assert len(LANGUAGES) == 33
    assert all(name.isascii() and name == name.strip() for name in LANGUAGES.values())


def test_an_unknown_language_reads_as_english() -> None:
    assert clean_language("tr") == "tr"
    assert [clean_language(value) for value in ("Turkish", "th", "", None, 7)] == ["en"] * 5
    assert language_of({"language": "multi"}) == "multi"
    assert language_of({"wake_enabled": True}) == "en"
    assert language_of(None) == "en"


def test_a_language_is_found_by_code_or_name() -> None:
    assert find_language(" Turkish ") == "tr"
    assert find_language("TR") == "tr"
    assert find_language("multilingual") == "multi"
    assert find_language("filipino") == "fil"
    assert find_language("Klingon") is None
    assert find_language("") is None


def test_speech_to_text_listens_in_every_language() -> None:
    assert stt_language("en") is Language.EN
    assert stt_language("fil") is Language.TL
    assert stt_language("multi") == "multi"
    assert all(isinstance(stt_language(code), Language) for code in ONE_LANGUAGE)
    assert [stt_endpointing(code) for code in ("en", "tr", "multi")] == [None, None, 100]


def test_the_default_voice_model_takes_every_language() -> None:
    assert tts_language("en") is None
    assert tts_language("multi") is None
    for code in ONE_LANGUAGE:
        spoken = language_to_elevenlabs_language(Language(code))
        assert spoken is not None
        assert elevenlabs_language_code(DEFAULT_TTS_MODEL, spoken) == code
    assert tts_language("fil") is Language.FIL


def test_a_heard_language_maps_back_to_the_list() -> None:
    assert heard_language("tr") == "tr"
    assert heard_language("en-US") == "en"
    assert heard_language("tl") == "fil"
    assert heard_language("th") is None
    assert heard_language("multi") is None


def test_only_another_language_adds_a_rule() -> None:
    assert language_rule("en") == ""
    assert language_rule("xx") == ""
    assert language_rule("fr").startswith("# Language\n- The user set your language to French.")
    assert language_rule("fr").endswith("\n\n")
