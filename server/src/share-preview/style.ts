/** The share page's only styles: inline, light and dark by the viewer's scheme, no script. */
export const SHARE_STYLE = `
:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--code:#f2f3f5;--link:#0969da;
--kw:oklch(0.5 0.2 310);--str:oklch(0.5 0.13 150);--lit:oklch(0.54 0.15 50);--fn:oklch(0.5 0.17 255);--add:#1a7f37;--del:#cf222e;
--page:#ffffff;--flag:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e6e8eb;--muted:#9aa4b1;--line:#30363d;--code:#171a21;--link:#58a6ff;
--kw:oklch(0.76 0.14 310);--str:oklch(0.78 0.13 150);--lit:oklch(0.8 0.12 60);--fn:oklch(0.76 0.12 245);--add:#3fb950;--del:#f85149;
--page:#e6e8eb;--flag:#d29922}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:12px 16px;border-bottom:1px solid var(--line)}
header .meta{flex:1 1 240px;min-width:0}
header h1{margin:0;font-size:16px;font-weight:600;overflow-wrap:anywhere}
.sub{color:var(--muted);font-size:13px}
.dl{border:1px solid var(--line);border-radius:6px;padding:6px 12px;color:var(--fg);text-decoration:none;font-size:14px}
main{max-width:960px;margin:0 auto;padding:16px}
pre{background:var(--code);border:1px solid var(--line);border-radius:6px;padding:12px;overflow:auto;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
pre.text{white-space:pre}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.92em}
.md{overflow-wrap:anywhere}
.md h1,.md h2{padding-bottom:4px;border-bottom:1px solid var(--line)}
.md h1{font-size:1.75em}
.md h2{font-size:1.4em}
.md h3{font-size:1.15em}
.md img,img.file,img.out{max-width:100%;height:auto}
.md a{color:var(--link)}
.md table{border-collapse:collapse;display:block;overflow:auto}
.md th,.md td{border:1px solid var(--line);padding:4px 10px}
.md blockquote{margin:0;padding:0 12px;color:var(--muted);border-left:3px solid var(--line)}
.none,.caption{color:var(--muted)}
.caption{margin:0 0 12px;font-size:13px}
.notice{margin:0 0 12px;padding:8px 12px;border:1px solid var(--line);border-radius:6px;color:var(--muted);font-size:13px}
img.drawing{display:block;margin:0 auto 16px;background:var(--page);border-radius:4px}
pre.code{padding:8px 0;counter-reset:line}
pre.code code{display:block;min-width:max-content;font-size:inherit}
pre.code.wrap code{min-width:0}
pre.code .l{display:block;padding:0 12px 0 calc(var(--gut) + 12px);text-indent:calc(-1 * (var(--gut) + 12px));min-height:1.5em}
pre.code.wrap .l{white-space:pre-wrap;overflow-wrap:anywhere}
pre.code .l::before{counter-increment:line;content:counter(line);display:inline-block;width:var(--gut);margin-right:12px;padding-right:8px;text-indent:0;text-align:right;color:var(--muted);border-right:1px solid var(--line);user-select:none;-webkit-user-select:none}
.tok-keyword{color:var(--kw)}
.tok-string{color:var(--str)}
.tok-literal{color:var(--lit)}
.tok-function,.tok-meta{color:var(--fn)}
.tok-comment{color:var(--muted);font-style:italic}
.tok-inserted{color:var(--add)}
.tok-deleted{color:var(--del)}
.pages{display:flex;flex-direction:column;align-items:center;gap:20px}
figure.page{margin:0;width:100%;max-width:900px}
img.page{display:block;width:100%;height:auto;background:var(--page);border:1px solid var(--line);border-radius:2px;box-shadow:0 1px 3px #0002}
figure.page figcaption{text-align:center;color:var(--muted);font-size:12px;margin-top:4px;user-select:none;-webkit-user-select:none}
.sheet{position:relative}
.tl{position:absolute;inset:1px;overflow:hidden;container-type:size;font-size:1px;line-height:1;color:transparent;cursor:text;user-select:text;-webkit-user-select:text}
.tl span{position:absolute;white-space:pre;font-family:monospace;transform-origin:0 0}
.tl ::selection{color:transparent;background:color-mix(in srgb,var(--link) 35%,transparent)}
details{margin:16px 0;border:1px solid var(--line);border-radius:6px;padding:8px 12px}
details summary{cursor:pointer;font-weight:600}
details pre{margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.table{max-width:100%;max-height:75vh;overflow:auto;border:1px solid var(--line);border-radius:6px}
.table table{border-collapse:separate;border-spacing:0;font-size:13px}
.table th,.table td{padding:4px 10px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);white-space:pre;max-width:40ch;overflow:hidden;text-overflow:ellipsis;text-align:left;vertical-align:top}
.table thead th{position:sticky;top:0;background:var(--code);font-weight:600;z-index:1}
.table tbody tr:nth-child(even) td{background:color-mix(in srgb,var(--code) 50%,transparent)}
.table td.num{text-align:right;font-variant-numeric:tabular-nums}
.listing td.name{white-space:pre-wrap;overflow-wrap:anywhere;max-width:60ch}
.flag{color:var(--flag);font-size:11px;border:1px solid currentColor;border-radius:4px;padding:0 4px;margin-left:6px}
.notebook .cell{margin:0 0 16px}
.notebook .prompt{color:var(--muted);font:12px ui-monospace,SFMono-Regular,Menlo,monospace;margin-bottom:2px}
.notebook pre.out{background:transparent;border:0;border-left:3px solid var(--line);border-radius:0;margin:4px 0;padding:4px 12px;white-space:pre-wrap;overflow-wrap:anywhere}
.notebook pre.out.err{border-left-color:var(--del)}
.notebook img.out{display:block;margin:4px 0;background:var(--page)}
.player{display:flex;flex-direction:column;align-items:center;gap:12px}
video.media{display:block;width:100%;height:auto;max-height:80vh;background:#000;border-radius:6px}
audio.media{display:block;width:100%;max-width:640px}
img.poster{display:block;max-width:100%;height:auto;max-height:80vh;border-radius:6px;border:1px solid var(--line)}
`
