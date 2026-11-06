# GitHub webhooks

Lets a webhook channel take GitHub's repository and organization events: workflow runs, deployments, pull requests and issues. Each event reaches the agents that follow the channel as a short line they can act on.

## Use it

1. Open Settings, Channels and add a webhook with the GitHub source.
2. Copy its URL and secret into the repository's or organization's webhook settings on GitHub, with the content type set to JSON.
3. Press Test to send a signed ping.

Seti checks the X-Hub-Signature-256 signature before the mod reads a delivery, so the mod never sees the secret.

## While it is off

GitHub webhooks refuse every delivery until you turn the mod on again, and GitHub leaves the New webhook menu.
