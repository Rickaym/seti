from typing import Any

import pytest
from fakes import TASK_LOGIN, FakeSeti

from seti_ea.toolkit import ToolResult
from seti_ea.tools import EaTools

LOGIN = f"/api/tasks/{TASK_LOGIN}"


async def confirm(tools: EaTools, name: str, args: dict[str, Any]) -> tuple[ToolResult, ToolResult]:
    asked = await tools.call(name, args)
    tools.user_turn()
    done = await tools.call(name, {**args, "confirmed": True})
    return asked, done


def shell(shell_id: str, description: str, status: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": shell_id,
        "tool_use_id": f"toolu_{shell_id}",
        "tool": "Bash",
        "command": "pnpm dev --port 5173",
        "description": description,
        "status": status,
        "exit_code": None,
        "started_at": "2026-09-27T11:50:00.000Z",
        "ended_at": None,
        "subagent": False,
        "pid": None,
        "has_output": True,
        **extra,
    }


def process(pid: int, command: str, kind: str, **extra: Any) -> dict[str, Any]:
    return {
        "pid": pid,
        "ns_pid": None,
        "ppid": 1,
        "start_ticks": pid * 10,
        "name": command.split()[0],
        "command": command,
        "kind": kind,
        "shell_id": None,
        "depth": 1,
        "cpu_percent": 12.4,
        "rss_bytes": 120_000_000,
        "elapsed_s": 300,
        **extra,
    }


@pytest.fixture
def busy(fake_seti: FakeSeti) -> FakeSeti:
    fake_seti.processes[TASK_LOGIN] = {
        "sampled_at": "2026-09-27T12:00:00.000Z",
        "open": True,
        "sandboxed": True,
        "shells": [
            shell("bdev", "Run the dev server", "running", pid=4100),
            shell(
                "btest",
                "Run the tests",
                "failed",
                exit_code=1,
                started_at="2026-09-27T11:40:00.000Z",
                ended_at="2026-09-27T11:42:00.000Z",
            ),
        ],
        "processes": [
            process(4000, "claude --output-format stream-json", "agent"),
            process(4001, "socat TCP-LISTEN:3128", "seti"),
            process(4100, "bash -c pnpm dev", "command", shell_id="bdev"),
            process(4200, "node scripts/watch.js", "command", ns_pid=7),
        ],
        "running": 2,
    }
    return fake_seti


async def test_lists_shells_first_then_other_processes(tools: EaTools, busy: FakeSeti) -> None:
    result = await tools.call("list_processes", {"task": "login"})
    assert result.ok
    assert result.text.splitlines() == [
        "Fix the login redirect bug has 1 background shell running, 1 ended, and 1 other process.",
        "- Run the dev server (Bash, shell bdev): running for 10 minutes, pid 4100",
        "- Run the tests (Bash, shell btest): failed with exit code 1 after 2 minutes",
        "Other processes:",
        "- pid 7: node scripts/watch.js: 12% CPU, 120 MB, 5 minutes",
    ]
    assert result.summary == "Listed processes of Fix the login redirect bug: 2 running"
    assert busy.writes() == []


async def test_lists_nothing_for_an_agent_without_a_session(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.processes[TASK_LOGIN] = {"open": False, "shells": [], "processes": [], "running": 0}
    result = await tools.call("list_processes", {"task": "login"})
    assert result.text == (
        "Fix the login redirect bug runs no background shells or other processes. "
        "Its Claude Code process is not open."
    )


async def test_stops_a_shell_by_description_only_after_the_users_yes(tools: EaTools, busy: FakeSeti) -> None:
    asked, done = await confirm(tools, "stop_process", {"task": "login", "target": "dev server"})
    assert "Not done yet" in asked.text
    assert 'stops the background shell "Run the dev server" of Fix the login redirect bug' in asked.text
    assert done.text == 'Stopped the background shell "Run the dev server" of Fix the login redirect bug.'
    assert busy.writes() == [("POST", f"{LOGIN}/shells/bdev/stop", {}, {})]


async def test_stops_a_process_by_its_sandbox_pid_with_its_start_time(tools: EaTools, busy: FakeSeti) -> None:
    _asked, done = await confirm(tools, "stop_process", {"task": "login", "target": "7"})
    assert done.text == "Stopped process 7 (node scripts/watch.js) of Fix the login redirect bug."
    assert busy.writes() == [("POST", f"{LOGIN}/processes/stop", {}, {"pid": 4200, "start_ticks": 42000})]


async def test_a_shell_pid_stops_the_shell_and_claude_code_is_never_a_target(
    tools: EaTools, busy: FakeSeti
) -> None:
    _asked, done = await confirm(tools, "stop_process", {"task": "login", "target": "4100"})
    assert done.text.startswith('Stopped the background shell "Run the dev server"')
    refused = await tools.call("stop_process", {"task": "login", "target": "4000"})
    assert not refused.ok
    assert refused.text.startswith('No process matches "4000"')
    ended = await tools.call("stop_process", {"task": "login", "target": "Run the tests"})
    assert not ended.ok
    assert busy.writes() == [("POST", f"{LOGIN}/shells/bdev/stop", {}, {})]
