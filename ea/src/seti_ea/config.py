"""Settings from systemd credentials, the process environment and the EA env file."""

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

DEFAULT_ENV_FILE = "~/.seti/ea.env"
DEFAULT_PORT = 3007
DEFAULT_MODEL = "gpt-6-sol"
# GPT-6 Sol and Luna take function tools on Chat Completions only at reasoning effort none.
DEFAULT_REASONING_EFFORT = "none"
MODEL_DEFAULT_EFFORT = "default"
DEFAULT_SETI_API = "http://127.0.0.1:3006"
# ElevenLabs voice the user chose for the EA.
DEFAULT_VOICE_ID = "Fahco4VZzobUeiPqni1S"
DEFAULT_TTS_MODEL = "eleven_flash_v2_5"
DEFAULT_HISTORY_MAX_TOKENS = 8000
DEFAULT_INBOX_POLL_SECS = 5.0
MIN_HISTORY_MAX_TOKENS = 200

REQUIRED_KEYS = ("DEEPGRAM_API_KEY", "OPENAI_API_KEY", "ELEVENLABS_API_KEY")
KEYS_DIR = "~/.seti/credentials"

# Secret settings and the systemd credential each comes from, as in deploy/seti-ea.service.
CREDENTIAL_FILES = {
    "DEEPGRAM_API_KEY": "deepgram-api-key",
    "OPENAI_API_KEY": "openai-api-key",
    "ELEVENLABS_API_KEY": "elevenlabs-api-key",
    "CLOUDFLARE_TURN_KEY_ID": "cloudflare-turn-key-id",
    "CLOUDFLARE_TURN_API_TOKEN": "cloudflare-turn-api-token",
    "SETI_API_TOKEN": "seti-api-token",
}


@dataclass(frozen=True, repr=False)
class Settings:
    """Everything the bot reads from its environment; key values are never logged."""

    deepgram_api_key: str
    openai_api_key: str
    elevenlabs_api_key: str
    elevenlabs_voice_id: str
    elevenlabs_model: str
    model: str
    turn_key_id: str
    turn_api_token: str
    seti_api: str
    port: int
    env_file: Path
    history_max_tokens: int = DEFAULT_HISTORY_MAX_TOKENS
    text_model: str = ""
    inbox_poll_secs: float = DEFAULT_INBOX_POLL_SECS
    seti_api_token: str = ""
    credentials_dir: Path | None = None
    reasoning_effort: str = DEFAULT_REASONING_EFFORT

    @property
    def keys_hint(self) -> str:
        """Where the user adds missing keys, for error messages."""
        if self.credentials_dir is not None:
            return f"{KEYS_DIR} (then restart seti-ea.service)"
        return str(self.env_file)

    @property
    def chat_model(self) -> str:
        """The model for typed chat: EA_TEXT_MODEL, else the voice model."""
        return self.text_model or self.model

    @property
    def llm_params(self) -> dict[str, str]:
        """Extra Chat Completions parameters: the reasoning effort, unless left to the model."""
        if self.reasoning_effort == MODEL_DEFAULT_EFFORT:
            return {}
        return {"reasoning_effort": self.reasoning_effort}

    @property
    def chat_missing(self) -> list[str]:
        """Names of keys the typed chat needs that are not set."""
        return ["OPENAI_API_KEY"] if self.openai_api_key == "" else []

    @property
    def missing(self) -> list[str]:
        """Names of required keys that are not set."""
        values = {
            "DEEPGRAM_API_KEY": self.deepgram_api_key,
            "OPENAI_API_KEY": self.openai_api_key,
            "ELEVENLABS_API_KEY": self.elevenlabs_api_key,
        }
        return [name for name in REQUIRED_KEYS if values[name] == ""]

    @property
    def configured(self) -> bool:
        """True when every key the voice pipeline needs is present."""
        return not self.missing

    @property
    def turn(self) -> bool:
        """True when Cloudflare TURN credentials can be requested."""
        return self.turn_key_id != "" and self.turn_api_token != ""

    def __repr__(self) -> str:
        return (
            f"Settings(model={self.model!r}, chat_model={self.chat_model!r}, "
            f"reasoning_effort={self.reasoning_effort!r}, seti_api={self.seti_api!r}, "
            f"port={self.port}, missing={self.missing!r}, turn={self.turn})"
        )


def parse_env_file(text: str) -> dict[str, str]:
    """Parse KEY=VALUE lines, allowing blank lines, # comments, `export` and quoted values."""
    values: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if line == "" or line.startswith("#"):
            continue
        line = line.removeprefix("export ").strip()
        key, sep, value = line.partition("=")
        key = key.strip()
        if sep == "" or key == "":
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key] = value
    return values


def read_env_file(path: Path) -> dict[str, str]:
    """The file's values, or nothing when it does not exist or cannot be read."""
    try:
        return parse_env_file(path.read_text(encoding="utf-8"))
    except OSError:
        return {}


def read_credentials(directory: Path | None) -> dict[str, str]:
    """Secret settings from the files systemd passes in $CREDENTIALS_DIRECTORY."""
    if directory is None:
        return {}
    values: dict[str, str] = {}
    for name, file in CREDENTIAL_FILES.items():
        try:
            value = (directory / file).read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if value != "":
            values[name] = value
    return values


def load_settings(environ: Mapping[str, str] | None = None) -> Settings:
    """Credentials win over the process env, which wins over the env file named by SETI_EA_ENV."""
    env = os.environ if environ is None else environ
    env_file = Path(env.get("SETI_EA_ENV") or DEFAULT_ENV_FILE).expanduser()
    credentials_dir = Path(env["CREDENTIALS_DIRECTORY"]) if env.get("CREDENTIALS_DIRECTORY") else None
    merged = {**read_env_file(env_file), **env, **read_credentials(credentials_dir)}

    def get(name: str, default: str = "") -> str:
        return merged.get(name, "").strip() or default

    port_text = get("EA_PORT", str(DEFAULT_PORT))
    port = int(port_text) if port_text.isdigit() else DEFAULT_PORT
    history_text = get("EA_HISTORY_MAX_TOKENS", str(DEFAULT_HISTORY_MAX_TOKENS))
    history_max_tokens = (
        max(int(history_text), MIN_HISTORY_MAX_TOKENS)
        if history_text.isdigit()
        else DEFAULT_HISTORY_MAX_TOKENS
    )
    poll_text = get("EA_INBOX_POLL_SECS", str(DEFAULT_INBOX_POLL_SECS))
    try:
        inbox_poll_secs = max(float(poll_text), 0.0)
    except ValueError:
        inbox_poll_secs = DEFAULT_INBOX_POLL_SECS
    return Settings(
        deepgram_api_key=get("DEEPGRAM_API_KEY"),
        openai_api_key=get("OPENAI_API_KEY"),
        elevenlabs_api_key=get("ELEVENLABS_API_KEY"),
        elevenlabs_voice_id=get("ELEVENLABS_VOICE_ID", DEFAULT_VOICE_ID),
        elevenlabs_model=get("ELEVENLABS_MODEL", DEFAULT_TTS_MODEL),
        model=get("EA_MODEL", DEFAULT_MODEL),
        text_model=get("EA_TEXT_MODEL"),
        reasoning_effort=get("EA_REASONING_EFFORT", DEFAULT_REASONING_EFFORT),
        turn_key_id=get("CLOUDFLARE_TURN_KEY_ID"),
        turn_api_token=get("CLOUDFLARE_TURN_API_TOKEN"),
        seti_api=get("SETI_API", DEFAULT_SETI_API).rstrip("/"),
        port=port,
        env_file=env_file,
        history_max_tokens=history_max_tokens,
        inbox_poll_secs=inbox_poll_secs,
        seti_api_token=get("SETI_API_TOKEN"),
        credentials_dir=credentials_dir,
    )
