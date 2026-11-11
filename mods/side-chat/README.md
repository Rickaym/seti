# Side chat

Ask an agent about its work while it runs. Type `/btw` and a question in the reply box, or pick Ask aside from the command palette or the agent's More actions menu. The answer comes from everything the agent has seen, in a side chat that never interrupts its turn or reaches its conversation. Like Claude Code's `/btw`, each answer stays in the agent's transcript as an aside.

## How it works

- Each question forks the agent's session in a short-lived Claude Code process with read-only tools, in the agent's own sandbox. The agent's process, session and transcript rows stay as they were.
- Seti keeps every answered question as an aside of the agent, with who asked it, when and what it cost, until you delete it or the agent is deleted. Archiving and restoring the agent keep its asides.
- Asides show in the agent's transcript at the time they were asked, as muted blocks that fold to one line. The dock lists them too, with a divider where a new chat starts.
- The next question follows up the newest chat, even after a reload or a restart; New chat starts a fresh one. A follow-up hands the fork the chat's six newest exchanges.
- Delete removes one aside, from the transcript or the dock, and Clear in the dock removes them all. Seti audits both, without the questions or answers.
- Send to agent passes a question and its answer to the agent as a normal message.
- What a question costs is added to the agent's cost.

The EA asks through this mod's `ask` action, and agents at Seti control Full through `mod_side-chat_ask`; an agent's question gets no file reads. The EA also reads an agent's asides with `asides` and deletes them with `clear`, after you say yes. Asides the EA or an agent asked carry its name.

While the mod is off, `/btw` and Ask aside say so with a Turn on button, and never reach the agent. Its asides stay stored but do not show until it is back on.
