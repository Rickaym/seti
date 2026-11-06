from fakes import TASK_LOGIN, FakeSeti

from seti_ea.agent_files import FILE_READ_CHARS
from seti_ea.chat import INBOX_TOOLS
from seti_ea.tools import EaTools


def chat_hit(message_id: int, kind: str, snippet: str) -> dict[str, object]:
    return {"id": message_id, "kind": kind, "created_at": "2026-09-25T12:00:00.000Z", "snippet": snippet}


async def test_finds_far_back_in_a_task_transcript(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.chat_hits = [
        chat_hit(910, "sdk", "...the redirect loops on /callback..."),
        chat_hit(42, "prompt", "Fix the redirect on /callback"),
    ]
    result = await tools.call("find_in_transcript", {"task": "login redirect", "query": "/callback"})
    assert result.ok
    assert result.text.splitlines() == [
        "2 messages in the transcript of Fix the login redirect bug match /callback, newest first:",
        '- message 910, agent, 2 days ago: "...the redirect loops on /callback..."',
        '- message 42, prompt, 2 days ago: "Fix the redirect on /callback"',
    ]
    assert result.summary == "Found 2 transcript messages"
    request = fake_seti.requests[-1]
    assert (request.url.path, dict(request.url.params)) == (
        f"/api/tasks/{TASK_LOGIN}/search",
        {"q": "/callback", "mode": "text", "limit": "10"},
    )


async def test_finds_whole_words_in_the_group_chat_and_says_when_more_exist(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    fake_seti.chat_hits = [chat_hit(77, "task", "release ships at 3pm"), chat_hit(12, "ea", "release moved")]
    fake_seti.chat_more = True
    result = await tools.call("find_in_team_chat", {"query": "release", "whole_words": True})
    assert result.text.splitlines() == [
        "2+ messages in the group chat match release, newest first:",
        '- message 77, an agent, 2 days ago: "release ships at 3pm"',
        '- message 12, you, 2 days ago: "release moved"',
        "Older matches exist; narrow the words to reach them.",
    ]
    assert dict(fake_seti.requests[-1].url.params) == {"q": "release", "mode": "words", "limit": "10"}


async def test_says_when_nothing_matches_and_needs_a_query(tools: EaTools) -> None:
    result = await tools.call("find_in_team_chat", {"query": "nowhere"})
    assert result.text == "Nothing in the group chat matches nowhere."
    missing = await tools.call("find_in_transcript", {"task": "login"})
    assert not missing.ok


async def test_finds_a_task_files_by_name_through_the_files_search(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    fake_seti.file_search = {
        "mode": "name",
        "hits": [
            {"root": "cwd", "path": "src/login/callback.ts", "type": "file", "marks": [10, 11]},
            {"root": "workspace", "path": "callbacks", "type": "dir", "marks": [0]},
        ],
        "truncated": True,
        "partial": False,
    }
    result = await tools.call(
        "find_in_transcript", {"task": "login", "query": "callback", "where": "file_names"}
    )
    assert result.ok
    assert result.text.splitlines() == [
        "2+ matches for callback in the file and folder names of Fix the login redirect bug:",
        "- login-app/src/login/callback.ts",
        "- Workspace/callbacks/",
        "More match; narrow the query to reach them.",
    ]
    search = next(r for r in fake_seti.requests if r.url.path.endswith("/files/search"))
    assert (search.url.path, dict(search.url.params)) == (
        f"/api/tasks/{TASK_LOGIN}/files/search",
        {"q": "callback", "mode": "name", "limit": "20"},
    )


async def test_finds_lines_inside_a_task_files(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.file_search = {
        "mode": "text",
        "hits": [
            {
                "root": "cwd",
                "path": "src/auth.ts",
                "line": 42,
                "text": "redirect(callback)",
                "marks": [[0, 8]],
            }
        ],
        "truncated": False,
        "partial": True,
    }
    result = await tools.call(
        "find_in_transcript", {"task": "login", "query": "redirect", "where": "file_text"}
    )
    assert result.text.splitlines() == [
        "1 match for redirect in the text in the files of Fix the login redirect bug:",
        '- login-app/src/auth.ts:42: "redirect(callback)"',
        "The search stopped early, so some files were not searched.",
    ]
    assert dict(fake_seti.requests[-2].url.params)["mode"] == "text"
    bad = await tools.call("find_in_transcript", {"task": "login", "query": "x", "where": "disk"})
    assert not bad.ok


async def test_says_when_no_file_matches(tools: EaTools) -> None:
    result = await tools.call("find_in_transcript", {"task": "login", "query": "zzz", "where": "file_names"})
    assert result.text == "Nothing in the file and folder names of Fix the login redirect bug matches zzz."


async def test_includes_tool_calls_and_output_only_when_asked(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.chat_hits = [chat_hit(911, "sdk", "Bash pnpm test /callback")]
    result = await tools.call(
        "find_in_transcript", {"task": "login", "query": "/callback", "include_tools": True}
    )
    assert result.ok
    assert dict(fake_seti.requests[-1].url.params) == {
        "q": "/callback",
        "mode": "text",
        "limit": "10",
        "tools": "true",
    }


def test_finding_is_a_read_the_inbox_may_use() -> None:
    assert {"find_in_team_chat", "find_in_transcript"} <= INBOX_TOOLS


async def test_reads_a_file_an_agent_sent_whole_by_its_path(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.file_texts = {"cwd:notes/role.md": "# Role\n\nDraft posts.\n"}
    result = await tools.call(
        "find_in_transcript", {"task": "@bug", "query": "`/work/notes/role.md`", "where": "file"}
    )
    assert result.ok
    assert result.text == (
        "notes/role.md of Fix the login redirect bug, all 21 characters, exactly as written:\n"
        "# Role\n\nDraft posts.\n"
    )
    assert result.summary == "Read role.md"
    text = next(r for r in fake_seti.requests if r.url.path.endswith("/files/text"))
    assert (text.url.path, dict(text.url.params)) == (
        f"/api/tasks/{TASK_LOGIN}/files/text",
        {"root": "cwd", "path": "notes/role.md"},
    )


async def test_reads_a_file_named_as_a_search_or_the_workspace_variable_names_it(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    fake_seti.file_texts = {"workspace:linkedin/role.md": "role", "cwd:src/a.ts": "a"}
    by_label = await tools.call(
        "find_in_transcript", {"task": "login", "query": "Workspace/linkedin/role.md", "where": "file"}
    )
    assert by_label.text.endswith("exactly as written:\nrole")
    by_var = await tools.call(
        "find_in_transcript", {"task": "login", "query": "$SETI_WORKSPACE/linkedin/role.md", "where": "file"}
    )
    assert by_var.text.endswith("exactly as written:\nrole")
    by_root = await tools.call(
        "find_in_transcript", {"task": "login", "query": "login-app/src/a.ts", "where": "file"}
    )
    assert by_root.text.endswith("exactly as written:\na")


async def test_says_when_a_file_read_is_clipped(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.file_texts = {"cwd:big.md": "x" * (FILE_READ_CHARS + 5)}
    result = await tools.call(
        "find_in_transcript", {"task": "login", "query": "/work/big.md", "where": "file"}
    )
    head, body = result.text.split("\n", 1)
    assert head.startswith(
        "big.md of Fix the login redirect bug is clipped: the first 30,000 of 30,005 characters"
    )
    assert len(body) == FILE_READ_CHARS
    assert result.summary == "Read part of big.md"


async def test_says_why_a_file_cannot_be_read(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.file_texts = {"cwd:shot.png": ""}
    missing = await tools.call(
        "find_in_transcript", {"task": "login", "query": "/elsewhere/x.md", "where": "file"}
    )
    assert (missing.ok, missing.text) == (
        False,
        "Fix the login redirect bug has no file at /elsewhere/x.md that you may read.",
    )
    folder = await tools.call("find_in_transcript", {"task": "login", "query": "/work/docs", "where": "file"})
    assert not folder.ok
    assert "is a folder" in folder.text
    binary = await tools.call(
        "find_in_transcript", {"task": "login", "query": "/work/shot.png", "where": "file"}
    )
    assert binary.text == "Seti did not open /work/shot.png: shot.png is not a text file the editor opens"
    handle = await tools.call(
        "find_in_transcript", {"task": "@nobody", "query": "/work/a.md", "where": "file"}
    )
    assert handle.text == "No agent has the handle @nobody."
