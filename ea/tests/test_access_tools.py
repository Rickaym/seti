from typing import Any

from fakes import TASK_LOGOUT, FakeSeti

from seti_ea.toolkit import ToolResult
from seti_ea.tools import EaTools

LOGOUT_ACCESS = f"/api/tasks/{TASK_LOGOUT}/access"


async def confirm(tools: EaTools, name: str, args: dict[str, Any]) -> tuple[ToolResult, ToolResult]:
    asked = await tools.call(name, args)
    tools.user_turn()
    done = await tools.call(name, {**args, "confirmed": True})
    return asked, done


async def test_set_mcp_default_asks_first_then_turns_it_off(tools: EaTools, fake_seti: FakeSeti) -> None:
    already = await tools.call("set_mcp_default", {"server": "slack", "enabled": True})
    assert already.text == "slack is already on by default."
    asked, done = await confirm(tools, "set_mcp_default", {"server": "slack", "enabled": False})
    assert "Not done yet" in asked.text
    assert "every agent without its own choice leaves it out" in asked.text
    assert done.text == "slack is now off by default for every agent without its own choice."
    assert fake_seti.writes() == [("PUT", "/api/mcp/defaults/slack", {}, {"enabled": False})]


async def test_local_servers_of_other_directories_are_off_unless_turned_on(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    fake_seti.mcp_local["web-staging"] = ["~/dashboard"]
    state = await tools.call("agent_access", {"task": "logout"})
    assert "off: web-staging (from ~/dashboard; off unless turned on)" in state.text
    already = await tools.call("set_mcp_default", {"server": "web-staging", "enabled": False})
    assert already.text == "web-staging is already off by default."
    asked, done = await confirm(tools, "set_mcp_default", {"server": "web-staging", "enabled": True})
    assert "It comes from the local config of ~/dashboard." in asked.text
    assert done.text == "web-staging is now on by default for every agent without its own choice."
    assert fake_seti.writes() == [("PUT", "/api/mcp/defaults/web-staging", {}, {"enabled": True})]
    assert fake_seti.mcp_defaults == {"web-staging": True}


async def test_set_mcp_default_names_what_matches(tools: EaTools) -> None:
    missing = await tools.call("set_mcp_default", {"server": "jira", "enabled": False})
    assert not missing.ok
    assert missing.text.startswith('No MCP server matches "jira".')


async def test_agent_access_reads_every_kind_without_a_gate(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.mcp_defaults["posthog"] = False
    fake_seti.access_defaults["ssh:jump"] = True
    fake_seti.task_access[TASK_LOGOUT] = {"ssh:k8s": True, "mcp:slack": False}
    state = await tools.call("agent_access", {"task": "logout"})
    assert state.text.startswith(
        "Fix the logout button: SSH hosts on: jump and k8s (its own choice). AWS off. "
        "MCP servers on: langfuse and seti; off: posthog and slack (its own choice). "
    )
    assert state.text.endswith("Credentials Default.")
    assert fake_seti.writes() == []


async def test_agent_access_names_a_seti_control_level_other_than_self(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    own = await tools.call("agent_access", {"task": "logout"})
    assert "Seti control" not in own.text
    task = next(t for t in fake_seti.tasks if t["id"] == TASK_LOGOUT)
    task["seti_control"] = "full"
    full = await tools.call("agent_access", {"task": "logout"})
    assert full.text.endswith("Credentials Default. It has Full Seti control, which only the user grants.")
    task["seti_control"] = "off"
    off = await tools.call("agent_access", {"task": "logout"})
    assert off.text.endswith(
        "Its Seti control is off, so it has no seti tools beyond its status line and file handoffs."
    )


async def test_agent_access_says_when_a_host_has_no_key(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.ssh_keys["k8s"] = None
    fake_seti.task_access[TASK_LOGOUT] = {"ssh:k8s": True}
    state = await tools.call("agent_access", {"task": "logout"})
    assert state.text.startswith(
        "Fix the logout button: SSH hosts on: k8s (its own choice; no key, so it cannot connect); off: jump. "
    )


async def test_ssh_hosts_lists_hosts_with_their_keys_and_sets_and_changes_nothing(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    fake_seti.access_defaults["ssh:jump"] = True
    fake_seti.ssh_keys["k8s"] = None
    fake_seti.ssh_sets["jump"] = ["Default", "Client"]
    listed = await tools.call("ssh_hosts", {})
    assert listed.text == (
        "2 SSH hosts: jump at 10.0.0.1:22, on by default; as ops with the key ops; every agent of "
        "Default and Client gets it. k8s at 10.0.0.2:22 via jump; no key yet, so no agent can use it; "
        "its host key is not trusted yet. Only the user adds or changes SSH hosts, keys, trusted host "
        "keys and the credentials that bundle hosts, in Settings under SSH and Credentials. You cannot."
    )
    assert fake_seti.writes() == []


async def test_set_agent_access_asks_then_stores_only_what_differs(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    fake_seti.mcp_defaults["posthog"] = False
    fake_seti.task_access[TASK_LOGOUT] = {"mcp:langfuse": False}
    args = {
        "task": "logout",
        "kind": "mcp",
        "enable": ["posthog"],
        "disable": ["slack"],
        "reset": ["langfuse"],
    }
    asked, done = await confirm(tools, "set_agent_access", args)
    assert (
        "This turns langfuse back to its default, posthog on and slack off for Fix the logout button"
        in asked.text
    )
    assert fake_seti.writes() == [
        ("PUT", LOGOUT_ACCESS, {}, {"kind": "mcp", "id": "posthog", "enabled": True}),
        ("PUT", LOGOUT_ACCESS, {}, {"kind": "mcp", "id": "slack", "enabled": False}),
        ("PUT", LOGOUT_ACCESS, {}, {"kind": "mcp", "id": "langfuse", "enabled": None}),
    ]
    assert fake_seti.task_access[TASK_LOGOUT] == {"mcp:posthog": True, "mcp:slack": False}
    assert done.text.startswith("Turned langfuse back to its default, posthog on and slack off")


async def test_set_agent_access_turns_a_plugin_on_for_one_agent(tools: EaTools, fake_seti: FakeSeti) -> None:
    args = {"task": "logout", "kind": "plugin", "enable": ["old-tools"]}
    _, done = await confirm(tools, "set_agent_access", args)
    assert done.ok
    assert fake_seti.task_access[TASK_LOGOUT] == {"plugin:847905ff-1788-49e3-a9df-1625d3b54de9": True}


async def test_set_agent_access_says_when_nothing_changes(tools: EaTools, fake_seti: FakeSeti) -> None:
    same = await tools.call("set_agent_access", {"task": "logout", "kind": "mcp", "enable": ["slack"]})
    assert same.text.startswith("No change. ")
    assert fake_seti.writes() == []


async def test_set_agent_access_never_touches_ssh_or_aws(tools: EaTools, fake_seti: FakeSeti) -> None:
    for kind, item in (("ssh", "k8s"), ("aws", "aws")):
        refused = await tools.call(
            "set_agent_access", {"task": "logout", "kind": kind, "enable": [item], "confirmed": True}
        )
        assert not refused.ok
        assert refused.text.startswith("Only the user gives an agent SSH hosts or AWS")
    assert fake_seti.writes() == []


async def test_agent_profile_reads_then_asks_before_switching(tools: EaTools, fake_seti: FakeSeti) -> None:
    state = await tools.call("set_agent_profile", {"task": "logout"})
    assert (
        state.text == "Fix the logout button uses the credentials Default. Credentials: Default and Client A."
    )
    asked, done = await confirm(tools, "set_agent_profile", {"task": "logout", "profile": "client a"})
    assert "gives Fix the logout button the credentials Client A in place of Default" in asked.text
    assert done.text == "Fix the logout button uses the credentials Client A from its next turn."
    assert fake_seti.writes() == [("PATCH", f"/api/tasks/{TASK_LOGOUT}", {}, {"profile_id": "p-client"})]


async def test_agent_profile_says_aws_stays_off_for_the_user_to_turn_on(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    role = "arn:aws:iam::123456789012:role/devops-agent"
    fake_seti.aws_outcomes[TASK_LOGOUT] = {"state": "off", "role": role, "region": "us-east-1"}
    _, done = await confirm(tools, "set_agent_profile", {"task": "logout", "profile": "client a"})
    assert done.text == (
        "Fix the logout button uses the credentials Client A from its next turn. Its AWS role stays "
        "off until the user turns AWS on in Fix the logout button's settings."
    )
    assert fake_seti.writes() == [("PATCH", f"/api/tasks/{TASK_LOGOUT}", {}, {"profile_id": "p-client"})]


async def test_agent_profile_names_what_matches(tools: EaTools, fake_seti: FakeSeti) -> None:
    missing = await tools.call("set_agent_profile", {"task": "logout", "profile": "Contractor"})
    assert not missing.ok
    assert missing.text.startswith('No credential matches "Contractor".')
    assert fake_seti.writes() == []
