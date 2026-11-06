from fakes import TASK_DOCS, TASK_LOGOUT, FakeSeti

from seti_ea.tools import EaTools


async def test_send_file_posts_from_the_sending_agent_to_the_handle(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    result = await tools.call(
        "send_file",
        {"from_task": "logout button", "to": "@docs", "paths": ["notes.md"], "note": "For the docs"},
    )
    assert result.ok
    assert result.text == (
        f"Sent 1 file from @button to @docs: /seti/workspace/{TASK_DOCS}/inbox/button/notes.md. "
        "The group chat message from @button names them."
    )
    assert fake_seti.posts()[-1] == (
        "/api/team/files",
        {"from": TASK_LOGOUT, "to": "docs", "paths": ["notes.md"], "note": "For the docs"},
    )


async def test_send_file_takes_the_receiver_by_title(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call(
        "send_file", {"from_task": "deploy docs", "to": "logout button", "paths": "a.txt"}
    )
    assert result.ok
    assert fake_seti.posts()[-1][1]["to"] == "button"


async def test_send_file_reports_what_seti_refused(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("send_file", {"from_task": "logout", "to": "docs", "paths": ["/etc/passwd"]})
    assert not result.ok
    assert result.text == (
        "Seti did not send them: /etc/passwd is outside your working folders and workspace"
    )
    too_many = await tools.call("send_file", {"from_task": "logout", "to": "docs", "paths": ["f"] * 11})
    assert too_many.text == "Send at most 10 files at once."
    assert [path for path, _ in fake_seti.posts()] == ["/api/team/files"]
