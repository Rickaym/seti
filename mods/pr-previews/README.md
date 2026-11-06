# PR previews

Finds the preview deployment of each PR from its comments, links to it beside the PR, and serves it on a seti.localhost subdomain so it opens next to the agent that made it.

## How it works

- Seti reads each PR's newest comments as it fetches the PR, and keeps only an HTTPS preview link.
- A Preview chip appears beside the PR in the agent's PR row.
- The subdomain proxy forwards each request to the preview's own HTTPS origin; the mod never sees a request.

Only you turn it on or off, because it serves pages on Seti's own host.
