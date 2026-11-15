"""The language the EA listens, speaks and writes in, from its settings in Seti."""

from collections.abc import Mapping
from typing import Any, cast

from pipecat.transcriptions.language import Language

DEFAULT = "en"
# Deepgram's code-switching mode: the EA hears any language and answers in the last one used.
MULTI = "multi"
# Deepgram's recommended endpointing for code-switching, in milliseconds.
MULTI_ENDPOINTING_MS = 100

# Deepgram Nova-3 and ElevenLabs Flash v2.5 both cover these; a server test holds it to shared.
LANGUAGES: dict[str, str] = {
    "en": "English",
    "multi": "Multilingual",
    "ar": "Arabic",
    "bg": "Bulgarian",
    "zh": "Chinese",
    "hr": "Croatian",
    "cs": "Czech",
    "da": "Danish",
    "nl": "Dutch",
    "fil": "Filipino",
    "fi": "Finnish",
    "fr": "French",
    "de": "German",
    "el": "Greek",
    "hi": "Hindi",
    "hu": "Hungarian",
    "id": "Indonesian",
    "it": "Italian",
    "ja": "Japanese",
    "ko": "Korean",
    "ms": "Malay",
    "no": "Norwegian",
    "pl": "Polish",
    "pt": "Portuguese",
    "ro": "Romanian",
    "ru": "Russian",
    "sk": "Slovak",
    "es": "Spanish",
    "sv": "Swedish",
    "ta": "Tamil",
    "tr": "Turkish",
    "uk": "Ukrainian",
    "vi": "Vietnamese",
}
# Deepgram calls Filipino by its Tagalog code.
_DEEPGRAM_CODES = {"fil": "tl"}
_FROM_DEEPGRAM = {heard: code for code, heard in _DEEPGRAM_CODES.items()}


def clean_language(value: object) -> str:
    """A code from the list; English for anything else."""
    return value if isinstance(value, str) and value in LANGUAGES else DEFAULT


def language_of(settings: object) -> str:
    """The language in Seti's EA settings or its pack prompt; English when it is missing."""
    if not isinstance(settings, dict):
        return DEFAULT
    return clean_language(cast(Mapping[str, Any], settings).get("language"))


def find_language(value: str) -> str | None:
    """The code for a code or an English name, such as tr or Turkish; None when not offered."""
    wanted = value.strip().casefold()
    return next((code for code, name in LANGUAGES.items() if wanted in (code, name.casefold())), None)


def stt_language(code: str) -> Language | str:
    """What Deepgram listens for: one language, or multi for any of them."""
    return MULTI if code == MULTI else Language(_DEEPGRAM_CODES.get(code, code))


def stt_endpointing(code: str) -> int | None:
    """Deepgram's endpointing: its default for one language, shorter for code-switching."""
    return MULTI_ENDPOINTING_MS if code == MULTI else None


def tts_language(code: str) -> Language | None:
    """The language ElevenLabs is held to; none for English and Multilingual, where it follows the text."""
    return None if code in (DEFAULT, MULTI) else Language(code)


def heard_language(tag: str) -> str | None:
    """The listed language of a tag Deepgram detected, such as en-US or tl; None when not offered."""
    base = tag.split("-")[0].casefold()
    code = _FROM_DEEPGRAM.get(base, base)
    return code if code in LANGUAGES and code != MULTI else None


def language_rule(code: str) -> str:
    """The prompt section that sets the language of replies; empty for English."""
    if code == DEFAULT or code not in LANGUAGES:
        return ""
    if code == MULTI:
        names = ", ".join(name for key, name in LANGUAGES.items() if key != MULTI)
        choice = (
            "- Answer in the language the user last spoke or typed in, and change with them when "
            f"they change. You can speak {names}; for any other language, and when you cannot "
            "tell, answer in English. Reports you leave in the inbox are in the language the user "
            "last used with you."
        )
    else:
        name = LANGUAGES[code]
        choice = (
            f"- The user set your language to {name}. Speak and write {name} everywhere: on a call, "
            "in the typed chat and in the reports you leave in the inbox, whatever language the "
            "notes, tool results and agents use."
        )
    return (
        "# Language\n"
        f"{choice}\n"
        "- Tool names and arguments, code, commands, file names, agent, repo and PR titles, and "
        "anything you quote from an agent or a message stay exactly as written; never translate them.\n"
        "- The example lines in this prompt are English; say the same thing naturally in your "
        "language instead of translating them word for word.\n"
        '- One exception: in the typed chat the closing question "Shall I go ahead?" stays in '
        "exactly those English words, because Seti shows the Yes and No buttons when it sees "
        "them. On a call, ask it in your language.\n\n"
    )
