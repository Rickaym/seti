"""The shipping metrics Seti counts, read for seti_overview."""

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any

from seti_ea.format import ago, and_list, duration, money, plural, pr_label
from seti_ea.toolkit import dicts

TOP_AGENTS = 5
WEEK = 7


def _num(fields: Mapping[str, Any], key: str) -> float:
    value = fields.get(key)
    return float(value) if isinstance(value, int | float) else 0.0


def _work(fields: Mapping[str, Any], span: str) -> str:
    turns = int(_num(fields, f"turns_{span}"))
    running = duration(_num(fields, f"run_ms_{span}") / 1000)
    return f"{plural(turns, 'turn')}, {running} running, {money(_num(fields, f'cost_{span}_usd'))}"


def _day_sum(days: Sequence[Mapping[str, Any]]) -> str:
    merged = sum(int(_num(day, "merged")) for day in days)
    turns = sum(int(_num(day, "turns")) for day in days)
    running = duration(sum(_num(day, "run_ms") for day in days) / 1000)
    cost = money(sum(_num(day, "cost_usd") for day in days))
    return f"{merged} merged, {plural(turns, 'turn')}, {running} running, {cost}"


def _day_lines(days: list[dict[str, Any]]) -> list[str]:
    """Today, and the 7 days before the last 7 to compare the week with."""
    if not days:
        return []
    lines = [f"Today: {_day_sum(days[-1:])}."]
    if len(days) >= 2 * WEEK:
        lines.append(f"The 7 days before those: {_day_sum(days[-2 * WEEK : -WEEK])}.")
    return lines


def _recent_line(fields: Mapping[str, Any], titles: Mapping[str, str], now: datetime) -> list[str]:
    merges = dicts(fields.get("recent"))
    if not merges:
        return []

    def merge(entry: Mapping[str, Any]) -> str:
        tasks = entry.get("task_ids")
        owners = (
            [titles.get(str(task), "an archived agent") for task in tasks] if isinstance(tasks, list) else []
        )
        by = f" by {and_list(owners)}" if owners else ""
        return f"{pr_label(str(entry.get('pr_url', '')))}{by}, {ago(entry.get('merged_at'), now)}"

    return ["Latest merges: " + "; ".join(merge(entry) for entry in merges) + "."]


def _agent_line(agent: Mapping[str, Any], titles: Mapping[str, str]) -> str:
    title = titles.get(str(agent.get("task_id")), "an archived agent")
    merged = int(_num(agent, "merged_30d"))
    return f"- {title}: {merged} merged, {_work(agent, '30d')}."


def metrics_lines(summary: Any, titles: Mapping[str, str], now: datetime) -> list[str]:
    """PRs merged and the streak, the work done by span and the latest merges, then the top agents."""
    fields: dict[str, Any] = summary if isinstance(summary, dict) else {}
    totals = fields.get("totals")
    total: dict[str, Any] = totals if isinstance(totals, dict) else {}
    streak = int(_num(fields, "streak_days"))
    streak_text = f", on a {streak}-day streak" if streak > 1 else ""
    lines = [
        f"Days count in {fields.get('zone', 'UTC')}.",
        f"PRs merged: {int(_num(total, 'merged_7d'))} in the last 7 days, "
        f"{int(_num(total, 'merged_30d'))} in the last 30{streak_text}.",
        f"Last 7 days: {_work(total, '7d')}.",
        f"Last 30 days: {_work(total, '30d')}.",
        *_day_lines(dicts(fields.get("days"))),
        *_recent_line(fields, titles, now),
    ]
    agents = dicts(fields.get("agents"))
    if not agents:
        return [*lines, "No agent ran a turn or merged a PR in the last 30 days."]
    lines.append("Agents by PRs merged in the last 30 days:")
    lines.extend(_agent_line(agent, titles) for agent in agents[:TOP_AGENTS])
    if len(agents) > TOP_AGENTS:
        lines.append(f"{plural(len(agents) - TOP_AGENTS, 'more agent')} worked in that time.")
    live = dicts(fields.get("live"))
    if live:
        lines.append(f"{plural(len(live), 'tool call')} running now.")
    return lines


def _wait(fields: Mapping[str, Any], key: str) -> str | None:
    latency = fields.get(key)
    if not isinstance(latency, dict) or not isinstance(latency.get("p50_ms"), int | float):
        return None
    p50 = _num(latency, "p50_ms") / 1000
    p95 = _num(latency, "p95_ms") / 1000
    return f"median {p50:.1f} seconds, 95th percentile {p95:.1f} seconds"


def ea_usage_lines(stats: Any) -> list[str]:
    """The EA's own model calls over the last 7 days: how many, their tokens and how fast they answered."""
    fields: dict[str, Any] = stats if isinstance(stats, dict) else {}
    calls = int(_num(fields, "calls_window"))
    if calls == 0:
        return ["The EA made no model calls in the last 7 days."]
    raw = fields.get("by_channel")
    where: dict[str, Any] = raw if isinstance(raw, dict) else {}
    split = (
        f"{int(_num(where, 'voice'))} on calls, {int(_num(where, 'chat'))} in chat, "
        f"{int(_num(where, 'inbox'))} for inbox reports, "
        f"{int(_num(where, 'think'))} thinking questions through"
    )
    today = int(_num(fields, "calls_today"))
    tools = plural(int(_num(fields, "tool_calls")), "tool call")
    lines = [f"The EA's own model calls: {today} today, {calls} in the last 7 days ({split}), with {tools}."]
    cached = fields.get("cached_share")
    share = f", {round(float(cached) * 100)}% of them cached" if isinstance(cached, int | float) else ""
    lines.append(
        f"Each call took {int(_num(fields, 'avg_prompt_tokens'))} input tokens on average{share}, "
        f"and wrote {int(_num(fields, 'avg_completion_tokens'))}."
    )
    for key, name in (("ttfb", "First token"), ("stt", "Speech to text"), ("tts", "Text to speech")):
        wait = _wait(fields, key)
        if wait is not None:
            lines.append(f"{name}: {wait}.")
    models = [str(model) for model in fields.get("models") or [] if isinstance(model, str)]
    if models:
        lines.append(f"Models: {and_list(models)}.")
    return lines


COMPARED = ("agree", "deferred", "tighter", "looser")
NOT_COMPARED = ("seti-hook", "unobserved", "interrupted")
TOP_DIFFERENCES = 5


def _difference(entry: Mapping[str, Any]) -> str:
    rule = str(entry.get("rule") or "") or "no rule"
    seti = f"Seti would {entry.get('verdict')} at step {entry.get('step')} ({rule})"
    claude = f"Claude Code chose to {entry.get('runtime')}"
    calls = plural(int(_num(entry, "calls")), "call")
    where = f"{entry.get('tool')} in {entry.get('mode')} mode"
    return f"- {entry.get('result')}: {where}, {seti}, {claude}: {calls}."


def _counts(fields: Mapping[str, Any], keys: Sequence[str]) -> list[str]:
    return [f"{int(_num(fields, key))} {key}" for key in keys if _num(fields, key)]


def shadow_lines(summary: Any) -> list[str]:
    """How Seti's own permission evaluator, run in shadow, compared with Claude Code since the day."""
    fields: dict[str, Any] = summary if isinstance(summary, dict) else {}
    raw = fields.get("results")
    results: dict[str, Any] = raw if isinstance(raw, dict) else {}
    since = fields.get("since", "the start")
    compared = sum(int(_num(results, key)) for key in COMPARED)
    lines = [
        "Seti's own permission evaluator runs in shadow: it decides every tool call beside Claude Code "
        "and changes no outcome."
    ]
    if compared == 0:
        lines.append(f"No tool calls compared since {since}.")
    else:
        lines.append(
            f"Since {since}: matched Claude Code on {int(_num(results, 'agree'))} "
            f"of {plural(compared, 'call')}; "
            f"{int(_num(results, 'deferred'))} left to its classifier, "
            f"{int(_num(results, 'tighter'))} stricter, {int(_num(results, 'looser'))} looser."
        )
    others = _counts(results, NOT_COMPARED)
    if others:
        lines.append(f"Not compared: {and_list(others)}.")
    trouble = _counts(results, ("failed",)) + _counts(fields, ("slow",))
    if trouble:
        lines.append(f"Decisions that went wrong: {and_list(trouble)}.")
    differences = dicts(fields.get("differences"))
    if differences:
        lines.append("Most frequent differences:")
        lines.extend(_difference(entry) for entry in differences[:TOP_DIFFERENCES])
    return lines
