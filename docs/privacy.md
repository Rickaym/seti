# Seti for Android privacy policy

Effective 29 October 2026. This policy covers the Seti app for Android (`dev.seti.android`).

TLDR: the app talks only to the Seti server you pair it with. It collects no analytics and sends
nothing to the developer. The one other party it involves is Google, whose Play services run the
QR code scanner and send Google their own usage diagnostics.

## What the app is

Seti is self-hosted software: you run the Seti server on your own machine. The app pairs with that
server, opens its web interface in Chrome as a Trusted Web Activity, and shows two home screen
widgets that read a summary of your agents from it. The developer runs no server for the app and
never receives your data.

## What the app sends, and where

- **To your Seti server only.** Pairing sends the one-time pairing code, a name for the phone (its
  device name, or its manufacturer and model) and the public half of the phone's device key. Each
  widget refresh then asks your server for its widget summary, signed with that key. The app
  contacts no other server.
- **The web interface runs in Chrome.** When the app opens Seti, Chrome loads your server's pages
  and keeps their cookies and sign-in, as it does in a browser tab. Chrome also reads
  `/.well-known/assetlinks.json` from your server to confirm that the app belongs to it. Chrome's
  own privacy policy covers Chrome.
- **Nothing goes to the developer.** The app contains no analytics, advertising, crash reporting or
  tracking SDK.

## The QR code scanner

The **Scan QR code** button uses Google's code scanner, which Google Play services provides and
which decodes the code on the phone. The app never gets camera access or the camera image, only the
text of the scanned code. Google Play services downloads the scanner on first use, and Google's ML
Kit sends Google diagnostics and usage data about it: device information (such as manufacturer,
model and Android version), the app's package name and version, a per-installation identifier and
performance metrics. Google describes this in its
[ML Kit data disclosure](https://developers.google.com/ml-kit/android-data-disclosure). To avoid the
scanner, paste the pairing link or type the server URL and code instead.

## What the app stores on the phone

- **A device key in Android Keystore.** Pairing creates a P-256 signing key in Android Keystore, in
  StrongBox on phones that have it. The key cannot be exported. Pairing again replaces it, and
  uninstalling the app deletes it.
- **The pairing and the last widget summary.** The app keeps your server's address, the device id
  your server gave the phone, and the last summary it fetched: the titles of your recent agents,
  why each waiting agent waits, what each running agent is doing, the state of their pull requests,
  counts of running and idle agents, and today's cost. With **Names** off for the phone in Seti,
  the summary holds generic labels instead of titles and reasons.
- **The last crash, if any.** After a crash the app keeps its error report on the phone and offers
  it to you on the next launch. It leaves the phone only if you copy and share it yourself.

The app excludes all of this from Android backups and device transfers. Uninstalling the app
deletes it.

## Permissions

The app asks for no runtime permissions. It holds network access to reach your server, and the
permissions Android's WorkManager needs to refresh the widgets in the background (wake lock,
network state, foreground service and running after a restart).

## Your control

Your Seti server holds everything the app sends: revoke the phone in Seti under Settings, Sign-in
and the device key stops working at once. Clear the app's storage or uninstall it to remove what it
keeps on the phone.

## Children

The app is a tool for software developers and is not directed at children.

## Changes

A new version of this policy takes effect when it is published here, with a new effective date.

## Contact

Write to the developer at the contact address on the app's Google Play listing.
