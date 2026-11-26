"""Permission rules read out for get_security_settings: what holds an agent's calls, never a change."""

from collections.abc import Mapping
from typing import Any

from seti_ea.format import and_list, plural
from seti_ea.question_tools import DATA_NOTE, data, verbatim
from seti_ea.seti import SetiClient
from seti_ea.toolkit import ToolResult, dicts, title_of

RULE_CHARS = 160
SHOWN = 12
BEHAVIOR_WORDS = {
    "allow": "Allow",
    "ask": "Ask",
    "deny": "Deny",
    "review": "Review (the user sees it before it runs)",
}
APPLIES_WORDS = {"all": "every agent", "sandboxed": "sandboxed agents", "unsandboxed": "unsandboxed agents"}

RULES_ARGS: dict[str, dict[str, Any]] = {
    "rules": {
        "type": "boolean",
        "description": "Instead, the permission rules that decide which calls run, ask or are refused.",
    },
    "agent": {
        "type": "string",
        "description": "With rules, this agent's own rules and its project's too, by its title.",
    },
}


def _rule(rule: Mapping[str, Any]) -> str:
    behavior = str(rule.get("behavior"))
    return f"{BEHAVIOR_WORDS.get(behavior, behavior)} {verbatim(rule.get('rule'), RULE_CHARS)}"


def _group(title: str, rules: list[str]) -> list[str]:
    if not rules:
        return []
    more = [f"- and {plural(len(rules) - SHOWN, 'more rule')}"] if len(rules) > SHOWN else []
    return [f"{title}:", *[f"- {rule}" for rule in rules[:SHOWN]], *more]


def _built_in(policy: Mapping[str, Any]) -> list[str]:
    return [
        f"{_rule(r)}, for {APPLIES_WORDS.get(str(r.get('applies')), str(r.get('applies')))}"
        for r in dicts(policy.get("built_in"))
    ]


def _inherited(policy: Mapping[str, Any], key: str) -> list[str]:
    return [f"{_rule(r)}, from {verbatim(r.get('source'), RULE_CHARS)}" for r in dicts(policy.get(key))]


def _gaps(policy: Mapping[str, Any]) -> list[str]:
    gaps = dicts(policy.get("review_gaps"))
    if not gaps:
        return []
    named = and_list([f"{g.get('label')} ({plural(int(g.get('uncovered') or 0), 'tool')})" for g in gaps])
    return [f"Review rules leave out tools that write or send on {named}."]


async def rules_text(seti: SetiClient, task: Mapping[str, Any] | None) -> ToolResult:
    """The rules every agent runs with, or one agent's, with Seti's guards and the timeout."""
    path = "/permissions" if task is None else f"/tasks/{task.get('id')}/permissions"
    found = await seti.get(path)
    policy: Mapping[str, Any] = found if isinstance(found, dict) else {}
    whose = "every agent" if task is None else title_of(task)
    lines = [f"The permission rules {whose} runs with; only the user adds, removes or answers them:"]
    lines += _group("The user's rules for every agent", [_rule(r) for r in dicts(policy.get("rules"))])
    if task is not None:
        lines += _group(f"Rules for {whose} alone", [_rule(r) for r in dicts(policy.get("own"))])
        project = [data(rule, "the repository", RULE_CHARS) for rule in _inherited(policy, "project")]
        lines += _group("From the project's Claude Code settings, which the repository holds", project)
    lines += _group("From the user's own Claude Code settings", _inherited(policy, "inherited"))
    lines += _group("Seti's built-in rules", _built_in(policy))
    guards = [str(g) for g in policy.get("guards") or []]
    lines += _group("Seti refuses, whatever the rules say", guards)
    lines += _gaps(policy)
    if task is not None and dicts(policy.get("project")):
        lines.append(DATA_NOTE)
    return ToolResult("\n".join(lines), f"Read the rules of {whose}")
