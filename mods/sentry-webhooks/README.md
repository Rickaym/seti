# Sentry webhooks

Lets a webhook channel take Sentry's integration events: issues, uptime checks, and issue and metric alerts.

## Use it

1. Open Settings, Channels and add a webhook with the Sentry source.
2. In Sentry, create an internal integration, turn on the webhook events you want, and paste the channel's URL.
3. Paste the integration's client secret into the channel, so Seti can check each delivery's signature.

Seti checks the Sentry-Hook-Signature header before the mod reads a delivery, so the mod never sees the secret.

## While it is off

Sentry webhooks refuse every delivery until you turn the mod on again.
