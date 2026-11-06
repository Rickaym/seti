from pathlib import Path

from seti_ea.config import (
    DEFAULT_HISTORY_MAX_TOKENS,
    DEFAULT_MODEL,
    DEFAULT_REASONING_EFFORT,
    DEFAULT_TTS_MODEL,
    DEFAULT_VOICE_ID,
    REQUIRED_KEYS,
    load_settings,
    parse_env_file,
)


def test_missing_keys_do_not_raise(tmp_path: Path) -> None:
    settings = load_settings({"SETI_EA_ENV": str(tmp_path / "absent.env")})
    assert not settings.configured
    assert settings.missing == ["DEEPGRAM_API_KEY", "OPENAI_API_KEY", "ELEVENLABS_API_KEY"]
    assert settings.missing == list(REQUIRED_KEYS)
    assert settings.model == DEFAULT_MODEL
    assert settings.llm_params == {"reasoning_effort": DEFAULT_REASONING_EFFORT}
    assert settings.elevenlabs_voice_id == DEFAULT_VOICE_ID
    assert settings.elevenlabs_model == DEFAULT_TTS_MODEL
    assert settings.port == 3007
    assert settings.seti_api == "http://127.0.0.1:3006"
    assert not settings.turn


def test_env_file_and_process_env_merge(tmp_path: Path) -> None:
    env_file = tmp_path / "ea.env"
    env_file.write_text(
        "\n".join(
            [
                "# keys",
                "DEEPGRAM_API_KEY=dg-file",
                "export OPENAI_API_KEY='op-file'",
                'ELEVENLABS_API_KEY="el-file"',
                "ELEVENLABS_VOICE_ID=voice-file",
                "ELEVENLABS_MODEL=eleven_turbo_v2_5",
                "CLOUDFLARE_TURN_KEY_ID=kid",
                "CLOUDFLARE_TURN_API_TOKEN=tok",
                "EA_MODEL=gpt-4.1",
                "SETI_API=http://127.0.0.1:3190/",
                "not a line",
                "",
            ]
        )
    )
    settings = load_settings({"SETI_EA_ENV": str(env_file), "DEEPGRAM_API_KEY": "dg-env", "EA_PORT": "3197"})
    assert settings.configured
    assert settings.deepgram_api_key == "dg-env"
    assert settings.openai_api_key == "op-file"
    assert settings.elevenlabs_api_key == "el-file"
    assert settings.elevenlabs_voice_id == "voice-file"
    assert settings.elevenlabs_model == "eleven_turbo_v2_5"
    assert settings.model == "gpt-4.1"
    assert settings.seti_api == "http://127.0.0.1:3190"
    assert settings.port == 3197
    assert settings.turn


def test_repr_never_shows_key_values(tmp_path: Path) -> None:
    settings = load_settings(
        {
            "SETI_EA_ENV": str(tmp_path / "absent.env"),
            "OPENAI_API_KEY": "sk-secret-value",
            "ELEVENLABS_API_KEY": "sk_secret_value",
            "CLOUDFLARE_TURN_API_TOKEN": "turn-secret",
        }
    )
    assert "secret" not in repr(settings)
    assert "secret" not in str(settings)


def test_blank_values_count_as_missing(tmp_path: Path) -> None:
    settings = load_settings(
        {
            "SETI_EA_ENV": str(tmp_path / "x"),
            "ELEVENLABS_API_KEY": "  ",
            "ELEVENLABS_VOICE_ID": "",
            "EA_PORT": "abc",
        }
    )
    assert "ELEVENLABS_API_KEY" in settings.missing
    assert settings.elevenlabs_voice_id == DEFAULT_VOICE_ID
    assert settings.port == 3007


def test_parse_env_file() -> None:
    assert parse_env_file("A=1\nB = two words \n=x\nC\n#D=4\nE='q'") == {"A": "1", "B": "two words", "E": "q"}


def test_history_limit_has_a_default_and_a_floor(tmp_path: Path) -> None:
    env = {"SETI_EA_ENV": str(tmp_path / "absent.env")}
    assert load_settings(env).history_max_tokens == DEFAULT_HISTORY_MAX_TOKENS
    assert load_settings({**env, "EA_HISTORY_MAX_TOKENS": "3000"}).history_max_tokens == 3000
    assert load_settings({**env, "EA_HISTORY_MAX_TOKENS": "10"}).history_max_tokens == 200
    unreadable = load_settings({**env, "EA_HISTORY_MAX_TOKENS": "lots"})
    assert unreadable.history_max_tokens == DEFAULT_HISTORY_MAX_TOKENS


def test_credentials_win_over_env_and_env_file(tmp_path: Path) -> None:
    credentials = tmp_path / "credentials"
    credentials.mkdir()
    (credentials / "deepgram-api-key").write_text("dg-credential\n")
    (credentials / "openai-api-key").write_text("")
    (credentials / "seti-api-token").write_text("token-from-systemd\n")
    env_file = tmp_path / "ea.env"
    env_file.write_text("DEEPGRAM_API_KEY=dg-file\nOPENAI_API_KEY=op-file\n")
    settings = load_settings(
        {
            "SETI_EA_ENV": str(env_file),
            "CREDENTIALS_DIRECTORY": str(credentials),
            "DEEPGRAM_API_KEY": "dg-env",
        }
    )
    assert settings.deepgram_api_key == "dg-credential"
    assert settings.openai_api_key == "op-file"
    assert settings.seti_api_token == "token-from-systemd"
    assert settings.keys_hint.startswith("~/.seti/credentials")
    assert "token-from-systemd" not in repr(settings)


def test_without_credentials_keys_come_from_the_env_file(tmp_path: Path) -> None:
    settings = load_settings({"SETI_EA_ENV": str(tmp_path / "ea.env"), "SETI_API_TOKEN": "dev-token"})
    assert settings.seti_api_token == "dev-token"
    assert settings.credentials_dir is None
    assert settings.keys_hint == str(tmp_path / "ea.env")


def test_reasoning_effort_can_be_raised_or_left_to_the_model(tmp_path: Path) -> None:
    env = {"SETI_EA_ENV": str(tmp_path / "absent.env")}
    assert load_settings({**env, "EA_REASONING_EFFORT": "low"}).llm_params == {"reasoning_effort": "low"}
    assert load_settings({**env, "EA_REASONING_EFFORT": "default"}).llm_params == {}
