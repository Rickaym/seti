"""What changed in Seti itself, read from its changelog for seti_overview."""

from datetime import UTC, datetime
from typing import Any

from seti_ea.format import ago, clip, parse_time, plural, zone_of
from seti_ea.toolkit import dicts

WHATS_NEW = "/mods/whats-new"
WHATS_NEW_OFF = (
    "What's new is off, so Seti has no changelog or update check to read. It turns on in Settings, Mods."
)
CHANGELOG_SCAN = 200
CHANGELOG_LIMIT = 15
DESCRIPTION_CHARS = 160
CHANGE_WORDS = {"feat": "Feature", "fix": "Fix", "perf": "Speed-up"}


def _day(value: Any, zone: str) -> str:
    when = parse_time(value)
    if when is None:
        return "Unknown day"
    local = when.astimezone(zone_of(zone) or UTC)
    return f"{local:%a} {local.day} {local:%b}"


def _entry_line(entry: dict[str, Any], zone: str) -> str:
    kind = CHANGE_WORDS.get(str(entry.get("type")), "Change")
    scope = f" ({entry.get('scope')})" if entry.get("scope") else ""
    pr = f", PR {entry.get('pr')}" if entry.get("pr") else ""
    new = ", new in this deploy" if entry.get("current") else ""
    text = clip(str(entry.get("description", "")), DESCRIPTION_CHARS)
    return f"- {_day(entry.get('date'), zone)}: {kind}{scope}: {text}{pr}{new}"


def update_lines(update: Any) -> list[str]:
    """Whether the branch Seti updates from has commits the running version lacks, and the fix."""
    fields: dict[str, Any] = update if isinstance(update, dict) else {}
    branch = fields.get("branch") or "main"
    match fields.get("state"):
        case "current":
            return [f"It is up to date with {branch}."]
        case "available":
            behind = plural(
                int(fields.get("behind") or 0), f"new commit on {branch}", f"new commits on {branch}"
            )
            notable = fields.get("notable")
            some = (
                "" if notable is None else f", {plural(int(notable), 'feature or fix', 'features and fixes')}"
            )
            lines = [f"An update is available: {behind}{some}."]
            command = str(fields.get("command") or "")
            if command:
                lines.append("To update, run this on the Seti host:")
                lines.extend(f"    {line}" for line in command.splitlines())
            return lines
        case "unknown":
            reason = str(fields.get("error") or "no answer").rstrip(".")
            return [f"It could not check for updates: {reason}."]
        case _:
            return []


def changelog_lines(log: Any, update: Any, now: datetime, zone: str) -> list[str]:
    """The running version, whether a newer one waits, then its newest features and fixes."""
    fields: dict[str, Any] = log if isinstance(log, dict) else {}
    version = fields.get("version")
    if not isinstance(version, dict):
        return ["Seti does not run from a git checkout here, so it has no changelog."]
    short = str(version.get("commit", ""))[:7]
    lines = [f"Seti runs version {short}, committed {ago(version.get('date'), now)}."]
    lines.extend(update_lines(update))
    entries = dicts(fields.get("entries"))
    notable = [e for e in entries if e.get("notable")]
    if not notable:
        lines.append(f"No features or fixes in the last {plural(len(entries), 'commit')}.")
        return lines
    current = sum(1 for e in notable if e.get("current"))
    if current:
        lines.append(f"This deploy brought {plural(current, 'feature or fix', 'features and fixes')}.")
    lines.append("Recent features and fixes, newest first:")
    lines.extend(_entry_line(e, zone) for e in notable[:CHANGELOG_LIMIT])
    if len(notable) > CHANGELOG_LIMIT:
        lines.append(f"{len(notable) - CHANGELOG_LIMIT} older ones are in Settings, About.")
    return lines
