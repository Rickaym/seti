# Seti for Android

A small Android app for Seti. It opens the full Seti UI in Chrome as a Trusted Web Activity, so your
passkey session and push notifications work as in the browser, and it adds two home screen widgets:
**Needs you** lists each agent that waits for you, with the reason Seti's notifications give (such
as `Asks to use Bash: terraform apply`) and how long it has waited. **Agents** lists agents by name,
running ones first, with what each is doing: its todo step or status line, the tool in use, its
running subagents and the state of its PR. Both fit as many agents as their size allows and count
the rest; tapping an agent opens it in Seti. Agents also has shortcuts to start an agent and call
the EA, and shows today's cost in its footer.

One build works with every Seti server. The app learns its server from pairing, then opens that
origin in the Trusted Web Activity and points the widgets at it. Pairing again with another server
switches to it.

The widgets read `GET /api/widget/summary` with a device key: pairing creates a P-256 key in Android
Keystore (StrongBox when the phone has one) and registers its public key with Seti. Each request
carries a fresh `Authorization: SetiDevice <proof>` header, an ES256 JWS bound to the method and URL.

## Build

You need JDK 17 or newer and the Android SDK (`ANDROID_HOME`, or `sdk.dir` in `local.properties`).

```sh
cd android
./gradlew assembleDebug            # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease bundleRelease lint test
```

`bundleRelease` writes the App Bundle for Google Play to
`app/build/outputs/bundle/release/app-release.aab`. Optional build settings:

| Setting                                    | Effect                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `-Pseti.host=seti.example.com`             | Verified app links: that host's `/pair` and `/agent/<id>` open the app.   |
| `~/.seti/android/signing.properties`       | Release signing: `storeFile`, `storePassword`, `keyAlias`, `keyPassword`. |
| `SETI_ANDROID_SIGNING=<path>`              | Reads the signing properties from another file.                           |
| `-Pseti.versionCode`, `-Pseti.versionName` | The version; plain builds use 1 and 0.1.0.                                |

Without `seti.host` the app claims no links: a tapped Seti link opens in Chrome, and pairing goes
through the app's scanner or a pasted pairing link. Build with `seti.host` only for your own server.

`storeFile` is relative to the properties file. CI can instead set `SETI_ANDROID_KEYSTORE`,
`SETI_ANDROID_KEYSTORE_PASSWORD`, `SETI_ANDROID_KEY_ALIAS` and `SETI_ANDROID_KEY_PASSWORD`. Without
signing settings the release APK and bundle are unsigned. To create a keystore:

```sh
mkdir -p ~/.seti/android && cd ~/.seti/android
keytool -genkeypair -keystore seti-release.jks -alias seti -keyalg RSA -keysize 4096 \
  -validity 10000 -dname "CN=Seti Android"
```

Seti's `assetlinks.json` names the official app with no setup. A build signed with your own key
needs its fingerprint under Self-built app in Settings, Sign-in; print it with:

```sh
$ANDROID_HOME/build-tools/<version>/apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
```

## Release

`pnpm android:release` ships a release in one of two ways:

| Command                                      | What it does                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm android:release`                       | APK to Firebase App Distribution, tag `android/v<name>-<code>`.        |
| `pnpm android:release --play`                | App Bundle to the Play internal testing track, tag `android/play/...`. |
| `pnpm android:release --play --track closed` | The same, to the closed testing track.                                 |
| `pnpm android:release --play --listing`      | A release and the store listing in one Play edit.                      |
| `pnpm android:release --listing`             | Only the store listing from `play/listings/`.                          |
| `pnpm android:release --play --build-only`   | Builds and verifies the App Bundle without uploading it.               |

Every release builds from a clean `android/` at the current commit. The versionCode is the commit
count (`git rev-list --count HEAD`), so a newer commit always has a higher code. Both channels share
it: a release fails when a tag of either channel has a higher code, and a code repeats only for the
same commit, so the Firebase and Play builds of one commit are the same version. The release notes
list the subjects of the commits that touched `android/` since the channel's last tag, or the last
10 of them before its first release.

Before uploading, the script checks the APK with `apksigner` and reads its version, checks the App
Bundle's signature with `jarsigner`, and refuses a bundle whose certificate differs from the APK's.
Play reports the versionCode it read from the upload, and the script discards the whole edit when it
differs.

### Firebase App Distribution

Setup, once:

1. In the Firebase project, create a service account with the **Firebase App Distribution Admin**
   role and save its JSON key as `~/.seti/android/firebase-sa.json`, or point
   `GOOGLE_APPLICATION_CREDENTIALS` at it.
2. Create `~/.seti/android/firebase.properties` with the Android app ID from the Firebase project
   settings and a comma-separated list of tester emails. `SETI_FIREBASE_APP_ID` and
   `SETI_FIREBASE_TESTERS` override them.

   ```properties
   appId=1:123456789012:android:0123456789abcdef
   testers=you@example.com
   ```

3. Set up release signing as in [Build](#build).

### Google Play

The script talks to the Google Play Developer API with a service account key at
`~/.seti/android/play-sa.json`, or the file `SETI_PLAY_CREDENTIALS` names. It reads the key only to
sign its token request and never prints it. Setup, once:

1. In Google Cloud, enable the **Google Play Android Developer API** for a project, create a service
   account there and save a JSON key for it as `~/.seti/android/play-sa.json`.
2. In the Play Console, under Users and permissions, invite the service account's email with the
   permission to release to testing tracks and to manage the store listing for this app.
3. Create the app `dev.seti.android` in the Play Console, enroll it in Play App Signing with the
   existing release key (see [Play App Signing](#play-app-signing-and-asset-links)), and upload the
   first bundle by hand: `pnpm android:release --play --build-only` builds it. Play accepts API
   uploads only once an app has its first bundle.

Until Play has reviewed and published the app once, it takes API releases only as drafts: the
script says so, and you roll the draft out in the Play Console. With managed publishing on, the
script commits the edit without sending it for review, and you send it from the Play Console.

### Store listing

`play/listings/en-US/` holds the listing: `title.txt` (up to 30 characters),
`short-description.txt` (80), `full-description.txt` (4000), and under `graphics/` the 512x512
`icon`, the 1024x500 `feature-graphic` and the `phone-screenshots`. `pnpm screenshots` regenerates
the graphics from `ui/public` and seeded demo data, next to the README screenshots. Widget
screenshots come from a real phone; add them to `graphics/phone-screenshots/` by hand. The listing
links the privacy policy in [`docs/privacy.md`](../docs/privacy.md).

### Tooling

The script uses `JAVA_HOME` when it has `javac` and is JDK 17 or newer, and otherwise the oldest
such JDK under `/usr/lib/jvm` or `/Library/Java/JavaVirtualMachines`. It finds the SDK through
`ANDROID_HOME`, `sdk.dir` in `local.properties`, `~/android-sdk`, `~/Android/Sdk` or
`~/Library/Android/sdk`.

## Play App Signing and asset links

Chrome shows Seti full screen only when the server's `assetlinks.json` names the certificate the
installed app is signed with. Chrome checks that statement alone: the app carries no
`asset_statements` for any host, so one build verifies on every Seti server.

With Play App Signing, Play re-signs every install with the **app signing key**, while you sign
uploads with the **upload key**. Seti's `OFFICIAL_ANDROID_APP` in `shared/src/devices.ts` lists the
certificate of the existing release key. Enroll the app in Play App Signing by uploading that key
as the app signing key (Play Console: Test and release, App integrity, "Use a different app signing
key", then export and upload from Java keystore). Play then signs with the same certificate,
Firebase and Play builds update each other, and no server changes. Keep the release key as the
upload key too, or register a new upload key; the upload key never reaches a phone.

If Play generates its own app signing key instead, Play installs carry a new certificate. Copy its
SHA-256 from Play Console, App integrity, App signing key certificate, add it to the
`cert_sha256` list of `OFFICIAL_ANDROID_APP`, and release Seti. Servers that run an older Seti open
the Play app in a Custom Tab with an address bar until they upgrade; Firebase builds keep working
with the old fingerprint, which stays in the list.

## Install

With USB debugging on: `adb install -r app/build/outputs/apk/release/app-release.apk`. Without a
cable, copy the APK to the phone and open it; Android asks once to allow installs from that app.

## Pair

1. In Seti, open Settings, Sign-in and choose **Pair phone**. It shows a QR code for
   `https://<host>/pair#code=<code>`, the code, and buttons to copy each.
2. Open the app and tap **Scan QR code**. On the phone itself, copy the pairing link in Seti and
   paste it into the app's URL field, which fills in the code; or type the Seti URL and the code.
3. Add the widgets: long-press the home screen, then **Widgets**, then **Seti**.

The phone's camera app opens a scanned pairing link in Chrome, which explains how to pair from the
app; only a build with `seti.host` opens it in the app. When Seti revokes the device, the widgets
show **Sign-in expired. Tap to pair again.** Long-press the app icon and choose **Pair again** to
pair at any time, with the same server or with another one.

The widgets refresh every 15 minutes, about every 5 minutes while an agent runs, when you open the app,
when you add a widget and when you tap the refresh button. The footer says when the summary was
fetched. To keep agent names off the home screen, turn off **Names** next to the phone in Settings,
Sign-in, Phones; its widgets then show generic labels such as `Agent 3f2a` and leave out reasons,
steps and PR names. When a refresh fails, the status line says why:

| Status             | Meaning                                                               |
| ------------------ | --------------------------------------------------------------------- |
| Can't reach Seti   | No answer: no network, a DNS or TLS failure, or a timeout.            |
| Blocked by a proxy | Something in front of Seti redirected the request, such as a sign-in. |
| Seti answered 403  | Seti or a proxy answered with that HTTP status.                       |
| Unexpected reply   | Seti answered, but not with a widget summary.                         |
| Sign-in expired    | Seti no longer accepts this phone's key; pair again.                  |
| Device key lost    | The phone's device key is gone; pair again.                           |

`adb logcat -s SetiRefresh` shows the full error of each failed refresh. On the server, the device's
last seen time in Settings, Sign-in moves with each accepted request (at most once a minute).

## What the server provides

- `/.well-known/assetlinks.json` on the Seti origin, so Chrome shows Seti full screen. Chrome on the
  phone fetches it from the server, so the phone must reach it without a sign-in. Without it, Seti
  opens in a Custom Tab with an address bar. Seti serves it for the official app
  (`OFFICIAL_ANDROID_APP` in `shared/src/devices.ts`) out of the box:

  ```json
  [
    {
      "relation": ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
      "target": {
        "namespace": "android_app",
        "package_name": "dev.seti.android",
        "sha256_cert_fingerprints": ["<official release certificate SHA-256>"]
      }
    }
  ]
  ```

  `handle_all_urls` lets the Trusted Web Activity run full screen (and lets a `seti.host` build
  verify its app links); `get_login_creds` shares the origin's passkeys with the app.

- `POST /api/devices/pair` with `{code, name, platform: "android", public_key}` (SPKI DER,
  base64url) returning `{device_id}`, and `GET /api/widget/summary` with device proofs. When a proxy
  such as Cloudflare Access fronts Seti, let these two paths and `assetlinks.json` through without a
  browser session; Seti checks the device proof itself.
- Agent links: the UI routes by hash, so the app opens `/agent/<id>` links as `/#agents/<id>`.
