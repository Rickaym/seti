"""Whether the user's own message says yes: an action on the user's word needs it, whatever the model thinks.

Words that pick a side, such as allow or deny, count only for a read-back of that side: "deny it"
never confirms a read-back that allows. A message with a no in it is never a yes.
"""

import re
import unicodedata
from collections.abc import Iterable

YES_WORDS = frozenset(
    {
        "yes",
        "yeah",
        "yea",
        "yep",
        "yup",
        "sure",
        "ok",
        "okay",
        "okey",
        "confirm",
        "confirmed",
        "correct",
        "affirmative",
        "oui",
        "si",
        "s\u00ed",
        "ja",
        "jawohl",
        "sim",
        "tak",
        "evet",
        "da",
        "\u0434\u0430",
        "\u03bd\u03b1\u03b9",
        "ya",
        "iya",
        "haan",
        "\u0646\u0639\u0645",
        "igen",
        "ano",
        "\u00e1no",
        "kyll\u00e4",
        "\u306f\u3044",
        "\ub124",
        "\uc608",
        "\u662f",
        "\u662f\u7684",
        "\u597d",
        "\u597d\u7684",
        "\u5bf9",
        "\u5c0d",
    }
)
YES_PHRASES = ("go ahead", "do it", "go for it", "please do")
NO_WORDS = frozenset(
    {
        "no",
        "nope",
        "nah",
        "not",
        "dont",
        "don't",
        "never",
        "wait",
        "stop",
        "cancel",
        "hold",
        "non",
        "nein",
        "nee",
        "nej",
        "nie",
        "n\u00e3o",
        "nao",
        "\u043d\u0435\u0442",
        "ne",
        "ei",
        "\u03cc\u03c7\u03b9",
        "\u3044\u3044\u3048",
        "\uc544\ub2c8",
        "\uc544\ub2c8\uc694",
        "\u4e0d",
        "\u4e0d\u662f",
        "\u0644\u0627",
        "nahin",
    }
)


def _words(text: str) -> list[str]:
    folded = unicodedata.normalize("NFKC", text).casefold().replace("\u2019", "'")
    return re.findall(r"[^\W_]+(?:'[^\W_]+)?", folded)


def said_yes(text: str, agrees: Iterable[str] = ()) -> bool:
    """True when the message holds a yes and no word of refusal.

    `agrees` adds the words that repeat the read-back's own side, such as allow for an Allow.
    """
    words = _words(text)
    if any(word in NO_WORDS for word in words):
        return False
    joined = f" {' '.join(words)} "
    yes = YES_WORDS | frozenset(agrees)
    return any(word in yes for word in words) or any(f" {phrase} " in joined for phrase in YES_PHRASES)
