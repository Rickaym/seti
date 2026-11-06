/**
 * Where a pairing QR code lands when a phone opens it in the browser instead of the app. The code
 * stays in the URL fragment, which never reaches the server, and the page runs no script.
 */
export const PAIR_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Pair with Seti</title>
<style>
  :root { color-scheme: light dark; --bg: #f8fafc; --fg: #0f172a; --muted: #475569; --line: #e2e8f0; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b1120; --fg: #e2e8f0; --muted: #94a3b8; --line: #1e293b; } }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
    font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width: 26rem; margin: 16px; padding: 24px; border: 1px solid var(--line); }
  h1 { font-size: 17px; margin: 0 0 12px; }
  p { margin: 0 0 10px; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>Pair with Seti</h1>
<p>This link pairs a phone with the Seti app. It opened in the browser, so pair from inside the app
instead.</p>
<p>Install the Seti app, open it and tap Scan QR code, then scan the code in Settings, Sign-in again.
Or copy this page's address and paste it into the app. The code works once, for five minutes.</p>
</main>
</body>
</html>
`
