# Vim mode

Single keys scroll and move between panels on a wide screen, as in Vim.

## Keys

- j and k scroll the active panel; gg and G go to its top and bottom.
- { and } step back and forward through your own messages, as Alt+[ and Alt+] do.
- h and l move to the previous and next panel; 1 to 9 pick one by position.
- : opens the command palette.
- / opens the find bar, and ? lists every key.
- Esc leaves a field, so the keys work again.
- i and a write in the active panel: its reply box, or its shell on a terminal.

## Terminals

A terminal takes every key, Esc included, while you type in it. Ctrl+\ then n leaves it for its panel in normal mode, as Ctrl+\ Ctrl+n does in Neovim; Ctrl+n works too where the browser lets the page have it, as an installed app does, while a browser tab keeps it for a new window. Any other key after Ctrl+\ goes to the shell.

Moving onto a terminal with h, l, H, L, J, K or a number stops on its panel without typing into the shell; i, a or a click goes in.

While Vim mode is on, a lone Ctrl+\ no longer reaches the shell, so programs do not see it as SIGQUIT. Press Ctrl+\ twice to send one.

Fields keep every key but Esc. On a phone, or whenever the layout shows one pane, Vim mode takes no keys at all.

It starts off, because single-key shortcuts surprise anyone who has not asked for them.
