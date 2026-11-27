# Pad

A text pad at the bottom of the navigation. Type into it and Seti keeps the text on the server, so
the same pad shows on every device and survives restarts.

## How it works

- On a phone the pad sits in the menu drawer, under the sections, and takes the height they leave.
  On a wide screen the sidebar is a rail of icons, so the pad is the Pad icon above the sidebar's
  tools. It opens the pad as a window over the page. Drag its header to move it and its edges or
  corners to resize it; with the header focused, the arrow keys move it and Shift with them
  resizes it. Each device remembers where the window is and whether it is open. The icon, the
  close button or Esc inside the window closes it.
- It saves a moment after you stop typing, when it loses focus and when the page hides. There is no
  Save button.
- When a save fails, the pad says so and tries again until it works. Until then this browser keeps
  the text, and brings it back after a reload.
- When the app comes back into focus, the pad takes the server's text unless you typed something
  here that is not saved yet. Two devices typing at once keep the last save.
- It holds up to 20,000 characters of plain text.

The pad is plain text that anyone signed in to Seti can read. Keep passwords and keys out of it.

The EA reads the pad with this mod's `read` action and adds a line with `append`, such as when you
ask it to note something down; Seti audits each line it adds, without the text. Agents get neither.
