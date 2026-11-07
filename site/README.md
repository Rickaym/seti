# Seti landing page

The product page served at https://rickaym.dev/seti/. It is plain HTML and CSS with no script, no
trackers and no third-party requests; JetBrains Mono ships in `fonts/` under the SIL Open Font
License (`fonts/OFL.txt`).

## Files

- `index.html` and `style.css`: the page. Every link and asset path is relative, so it works under
  the `/seti/` sub-path.
- `build.sh`: assembles `dist/seti/` with the page, the font, `og.png`, the favicons from
  `ui/public/` and every screenshot `index.html` references from `docs/screenshots/`.
- `og.png`: the 1200 by 630 preview image for Open Graph and Twitter cards.
- `_headers` and `_redirects`: Cloudflare Pages headers (a strict CSP with no script) and the
  redirects from `/` and `/seti` to `/seti/`.

The page reads its screenshots from `docs/screenshots/`, so a retaken screenshot reaches it on the
next build. To add, rename or remove one, edit its `<picture>` in `index.html`: the dark variant
goes in the `<source>`, the light one in the `<img>`. The build fails and names the file when the
page references a screenshot that does not exist, and `pnpm check` and CI run it as
`pnpm check:site`, so a screenshot change that breaks the page fails its PR.

## Preview locally

```sh
bash site/build.sh
cd site/dist && python3 -m http.server 8765
```

Then open http://127.0.0.1:8765/seti/.

## Deploy on Cloudflare

The page deploys as a Cloudflare Pages project, and a Worker route sends rickaym.dev/seti to it.
Pages alone cannot serve one path of a domain, so the Worker is what puts it under `/seti`.

### 1. Create the Pages project

1. In the Cloudflare dashboard, open Workers and Pages, then Create, then Pages, then Connect to
   Git, and pick the `rickaym/seti` repository.
2. Set the project name to `seti-site`, the production branch to `main`, and these build
   settings:
   - Framework preset: None
   - Root directory: `site`
   - Build command: `bash build.sh`
   - Build output directory: `dist`
3. Save and deploy. The first build publishes https://seti-site.pages.dev/seti/; open it to check
   the page before routing the domain.

With `site` as the root directory, Pages finds no `package.json` and skips the dependency install,
so a build takes seconds. To limit builds to changes that touch the page, open the project's
Settings, Builds, Build watch paths, and include `site/*`, `docs/screenshots/*` and `ui/public/*`.

To deploy from a machine instead of Git, run `bash site/build.sh`, then
`npx wrangler pages deploy site/dist --project-name seti-site --branch main`.

### 2. Route rickaym.dev/seti to it

1. Open Workers and Pages, then Create, then Workers, and create a Worker named `seti-route` with
   this code:

   ```js
   const ORIGIN = 'https://seti-site.pages.dev'

   export default {
     async fetch(request) {
       const url = new URL(request.url)
       if (url.pathname === '/seti') {
         return Response.redirect(`${url.origin}/seti/${url.search}`, 301)
       }
       return fetch(new Request(ORIGIN + url.pathname + url.search, request))
     },
   }
   ```

2. Deploy it, then open the Worker's Settings, Domains and Routes, and add two routes on the
   `rickaym.dev` zone: `rickaym.dev/seti` and `rickaym.dev/seti/*`.
   Worker routes run only on proxied traffic, so the `rickaym.dev` DNS record must be proxied
   (orange cloud), which it already is when the zone serves a site through Cloudflare.
3. Open https://rickaym.dev/seti and check that it redirects to `/seti/` and that the page, its
   screenshots and the font load. The rest of rickaym.dev is untouched, since the routes match only
   `/seti`.

The page's canonical URL and its Open Graph and Twitter image point at https://rickaym.dev/seti/.
Link previews cache the image, so after changing `og.png`, re-scrape the URL in each platform's
card validator.
