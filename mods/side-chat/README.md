# Side chat

Ask an agent about its work while it runs. Type `/btw` and a question in the reply box, or pick Ask aside from the command palette or the agent's More actions menu. The answer comes from everything the agent has seen, in a side chat that never interrupts its turn or reaches its transcript.

## How it works

- Each question forks the agent's session in a short-lived Claude Code process with read-only tools, in the agent's own sandbox. The agent's process, session and transcript stay as they were.
- A side chat takes up to eight questions. Closing it discards them; nothing is stored.
- Send to agent passes a question and its answer to the agent as a normal message.
- What a question costs is added to the agent's cost.

The EA asks through this mod's `ask` action, and agents at Seti control Full through `mod_side-chat_ask`; an agent's question gets no file reads.

While the mod is off, `/btw` and Ask aside say so with a Turn on button, and never reach the agent.
