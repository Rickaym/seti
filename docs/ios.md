# Seti on iPhone and iPad

TLDR: open Seti in Safari, add it to the Home Screen and open it from there. The Home Screen app
runs full screen, gets push notifications and shows the Needs you count on its icon. A native
companion app for Home Screen widgets is planned; the full UI stays in the Home Screen app.

## Install

Seti must be reachable over https on a public name, which `SETI_PUBLIC_URL` with a reverse proxy
or a Cloudflare Tunnel gives (see [Setup](setup.md#exposing-seti-remotely)). Push needs iOS or
iPadOS 16.4 or later.

1. Open your Seti address in Safari and sign in with a passkey. The first passkey takes the code
   that `pnpm setup-code` prints on the host.
2. Tap Share (on iOS 26 it is in the More menu), then Add to Home Screen, then Add.
3. Open Seti from the Home Screen. It keeps its own cookies and storage, apart from Safari, so sign
   in once more; the passkey from step 1 works here too. Behind Cloudflare Access, the Access
   login also comes up once more inside the app.
4. In Settings, Notifications, turn on Push and allow notifications when iOS asks. Test push sends
   one to check.

Safari in a browser tab cannot get push on iOS. Settings, Notifications says so there and shows
these steps.

## What works

- **Layout.** The app runs without browser chrome. The header, the status bar, the reply box, the
  terminal keys, sheets, toasts and the phone file viewer keep clear of the notch, the rounded
  corners and the home indicator. The status bar style is `default`, so iOS draws the clock in
  its own light or dark bar above the page; a translucent bar would put white text over Seti's
  light header. An open agent hands the chat the header's and status bar's room: its own
  one-row header clears the notch, the reply box clears the home indicator, and the back button
  carries the Needs you count.
- **Push.** Seti asks for permission inside the tap on Push, as iOS requires, and sends through
  Apple's push service with a TTL, an urgency and a per-agent topic, so a newer push about an
  agent replaces the older one. A push stays well under Apple's 4 KB limit. Tapping one opens
  that agent in the app.
- **Badge.** The app icon shows how many agents need you. Each push carries the count, and the
  open app keeps it in step with the status bar. iOS shows the badge only once notifications are
  allowed.
- **Passkeys.** Sign-in and adding a passkey work in Safari and in the Home Screen app with
  iCloud Keychain or a security key. Seti asks for a discoverable credential with user
  verification, ES256 or RS256 and no attestation, all of which Safari accepts.
- **Files.** Attach opens the iOS picker with Photo Library, Take Photo and Choose File. Downloads
  go to the Files app. Links to other sites, such as pull requests, open in a Safari sheet over
  the app, and Done returns to Seti.
- **Navigation.** There is no browser back button, so an agent, a settings page and a file each
  have their own back arrow on a phone. iOS has no pull to refresh in a Home Screen app; Seti
  refreshes live and offers Reload when a new version is waiting.

Not supported on iOS: the manifest shortcuts (New agent and Needs you on Android), and a launch
screen in Seti's colours, which iOS takes only from a startup image for every device size and
theme. The launch shows a plain screen for a moment instead.

## Native companion app

The plan is a small native app beside the Home Screen app, like the Android one, rather than a
native shell around the whole UI.

- **Widgets.** WidgetKit widgets show Needs you and the agent counts from
  `GET /api/widget/summary`, the endpoint the Android widgets read.
- **Device key.** Pairing creates a P-256 key in the Secure Enclave, which never leaves the phone,
  and registers its public key with `platform: "ios"`. Each widget request carries a fresh
  `Authorization: SetiDevice <proof>`, the ES256 JWS described in [Security](security.md). The app
  scans the pairing QR code itself, since a universal link would need an
  `apple-app-site-association` file on every user's own domain.
- **Full UI stays in Safari.** Passkeys in a `WKWebView` need the Associated Domains entitlement
  for each domain, fixed when the app is signed. Seti runs on each user's own domain, so one
  published app cannot carry it, while the Home Screen app gets passkeys and push from Safari as
  is.
- **Needs.** A Mac with Xcode, and an Apple Developer Program membership to sign the app and its
  widget extension for longer than a week and to share data between them through an App Group.
