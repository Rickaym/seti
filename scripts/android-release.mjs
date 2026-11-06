import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { publish, readListings } from './lib/play-api.mjs'

// Builds the signed release, ships it to Firebase App Distribution or Google Play and tags it.

const FIREBASE_TOOLS = 'firebase-tools@15.34.0'
const MIN_JDK = 17
const PACKAGE_NAME = 'dev.seti.android'
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ANDROID = join(ROOT, 'android')
const APK_DIR = join(ANDROID, 'app/build/outputs/apk/release')
const BUNDLE_DIR = join(ANDROID, 'app/build/outputs/bundle/release')
const LISTINGS = join(ANDROID, 'play/listings')
const SETI_ANDROID = join(homedir(), '.seti/android')
const FIREBASE_PROPERTIES = join(SETI_ANDROID, 'firebase.properties')
const JDK_SEARCH_DIRS = ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines']
const SDK_SEARCH_DIRS = [
  join(homedir(), 'android-sdk'),
  join(homedir(), 'Android/Sdk'),
  join(homedir(), 'Library/Android/sdk'),
]
const TAG_PREFIX = 'android/'
const PLAY_TAG_PREFIX = 'android/play/'
/** Play's API names for the tracks this script releases to. */
const PLAY_TRACKS = new Map([
  ['internal', 'internal'],
  ['closed', 'alpha'],
])

/** @typedef {'firebase' | 'play'} Channel */
/** @typedef {{ appId: string, testers: string, credentials: string }} FirebaseConfig */
/** @typedef {{ home: string, major: number }} Jdk */
/** @typedef {{ tag: string, code: number, commit: string, channel: Channel }} PastRelease */
/** @typedef {{ code: number, name: string, digest: string }} Built */

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`android:release: ${message}`)
  process.exit(1)
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
function capture(command, args, env = process.env) {
  return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', env }).trim()
}

/**
 * @param {string} file
 * @returns {Map<string, string>}
 */
function readProperties(file) {
  /** @type {Map<string, string>} */
  const props = new Map()
  if (!existsSync(file)) {
    return props
  }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    const split = trimmed.indexOf('=')
    if (trimmed !== '' && !trimmed.startsWith('#') && !trimmed.startsWith('!') && split > 0) {
      props.set(trimmed.slice(0, split).trim(), trimmed.slice(split + 1).trim())
    }
  }
  return props
}

/** @returns {string | undefined} */
function signingProblem() {
  const signing = process.env.SETI_ANDROID_SIGNING ?? join(SETI_ANDROID, 'signing.properties')
  if (process.env.SETI_ANDROID_KEYSTORE === undefined && !existsSync(signing)) {
    return `No signing settings at ${signing}: set SETI_ANDROID_SIGNING or SETI_ANDROID_KEYSTORE.`
  }
  return undefined
}

/** @param {(string | undefined)[]} problems */
function failOn(problems) {
  const found = problems.filter((problem) => problem !== undefined)
  if (found.length > 0) {
    fail(`${found.join('\n  ')}\nSee the Release section of android/README.md.`)
  }
}

/** @returns {FirebaseConfig} */
function firebaseConfig() {
  const props = readProperties(FIREBASE_PROPERTIES)
  const appId = process.env.SETI_FIREBASE_APP_ID ?? props.get('appId') ?? ''
  const testers = process.env.SETI_FIREBASE_TESTERS ?? props.get('testers') ?? ''
  const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? join(SETI_ANDROID, 'firebase-sa.json')
  failOn([
    appId === '' ? `No Firebase app ID: set SETI_FIREBASE_APP_ID or appId in ${FIREBASE_PROPERTIES}.` : undefined,
    testers === '' ? `No testers: set SETI_FIREBASE_TESTERS or testers in ${FIREBASE_PROPERTIES}.` : undefined,
    existsSync(credentials)
      ? undefined
      : `No service account key at ${credentials}: set GOOGLE_APPLICATION_CREDENTIALS.`,
    signingProblem(),
  ])
  return { appId, testers, credentials }
}

/**
 * @param {{ upload: boolean, build: boolean }} needs
 * @returns {string}
 */
function playCredentials(needs) {
  const credentials = process.env.SETI_PLAY_CREDENTIALS ?? join(SETI_ANDROID, 'play-sa.json')
  failOn([
    !needs.upload || existsSync(credentials)
      ? undefined
      : `No Play service account key at ${credentials}: set SETI_PLAY_CREDENTIALS.`,
    needs.build ? signingProblem() : undefined,
  ])
  return credentials
}

/**
 * @param {string} home
 * @returns {Jdk | undefined}
 */
function jdkAt(home) {
  const release = join(home, 'release')
  if (!existsSync(join(home, 'bin/javac')) || !existsSync(release)) {
    return undefined
  }
  const version = /^JAVA_VERSION="(?:1\.)?(\d+)/m.exec(readFileSync(release, 'utf8'))?.[1]
  const major = Number(version ?? 0)
  return major >= MIN_JDK ? { home: realpathSync(home), major } : undefined
}

/** @returns {Jdk} */
function findJdk() {
  const fromEnv = process.env.JAVA_HOME === undefined ? undefined : jdkAt(process.env.JAVA_HOME)
  if (fromEnv) {
    return fromEnv
  }
  const found = JDK_SEARCH_DIRS.filter((dir) => existsSync(dir))
    .flatMap((dir) => readdirSync(dir).flatMap((name) => [join(dir, name), join(dir, name, 'Contents/Home')]))
    .map((home) => jdkAt(home))
    .filter((jdk) => jdk !== undefined)
    .sort((a, b) => a.major - b.major)
  return found[0] ?? fail(`No JDK ${String(MIN_JDK)}+ with javac: set JAVA_HOME to one.`)
}

/** @returns {string} */
function findSdk() {
  const local = readProperties(join(ANDROID, 'local.properties')).get('sdk.dir')
  const candidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, local, ...SDK_SEARCH_DIRS]
  const sdk = candidates.find((dir) => dir !== undefined && existsSync(join(dir, 'build-tools')))
  return sdk ?? fail('No Android SDK: set ANDROID_HOME or sdk.dir in android/local.properties.')
}

/**
 * @param {string} sdk
 * @returns {string}
 */
function buildTools(sdk) {
  const dir = join(sdk, 'build-tools')
  const versions = readdirSync(dir)
    .filter((version) => existsSync(join(dir, version, 'apksigner')))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  const latest = versions[0] ?? fail(`No build-tools with apksigner under ${dir}.`)
  return join(dir, latest)
}

/** @returns {PastRelease[]} Every release tag, newest first. */
function pastReleases() {
  const refs = capture('git', [
    'for-each-ref',
    '--sort=-creatordate',
    '--format=%(refname:short) %(objectname) %(*objectname)',
    `refs/tags/${TAG_PREFIX}`,
  ])
  return refs
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [tag = '', object = '', peeled = ''] = line.split(' ')
      return {
        tag,
        code: Number(/-(\d+)$/.exec(tag)?.[1] ?? 0),
        commit: peeled === '' ? object : peeled,
        channel: tag.startsWith(PLAY_TAG_PREFIX) ? 'play' : 'firebase',
      }
    })
}

/**
 * Keeps versionCode monotonic across channels: a code may repeat only for the same commit.
 * @param {PastRelease[]} past
 * @param {number} code
 * @param {string} head
 * @param {Channel} channel
 */
function checkVersionCode(past, code, head, channel) {
  const higher = past.find((release) => release.code > code)
  if (higher !== undefined) {
    fail(`versionCode ${String(code)} is below ${higher.tag}: release from a newer commit.`)
  }
  const same = past.filter((release) => release.code === code)
  const elsewhere = same.find((release) => release.commit !== head)
  if (elsewhere !== undefined) {
    fail(`versionCode ${String(code)} already went out from another commit as ${elsewhere.tag}.`)
  }
  const done = same.find((release) => release.channel === channel)
  if (done !== undefined) {
    fail(`This commit already went to ${channel} as ${done.tag}.`)
  }
}

/**
 * @param {string | undefined} lastTag
 * @param {{ name: string, code: number, sha: string }} version
 */
function releaseNotes(lastTag, version) {
  const range = lastTag === undefined ? ['-10'] : [`${lastTag}..HEAD`]
  const subjects = capture('git', ['log', '--format=%s', ...range, '--', 'android'])
    .split('\n')
    .filter((subject) => subject !== '')
  const changes =
    subjects.length > 0
      ? subjects.map((subject) => `- ${subject}`)
      : [`No Android changes since ${lastTag ?? 'the start'}.`]
  return [`Seti ${version.name} (${String(version.code)}) at ${version.sha}`, '', ...changes, ''].join('\n')
}

/**
 * @param {string} tools
 * @param {string} apk
 * @param {NodeJS.ProcessEnv} env
 * @returns {Built}
 */
function verifyApk(tools, apk, env) {
  if (!existsSync(apk)) {
    const unsigned = existsSync(join(APK_DIR, 'app-release-unsigned.apk'))
    fail(unsigned ? 'Gradle built an unsigned APK: check the signing settings.' : `No APK at ${apk}.`)
  }
  const result = spawnSync(join(tools, 'apksigner'), ['verify', '--print-certs', apk], { encoding: 'utf8', env })
  if (result.status !== 0) {
    fail(`apksigner does not verify ${apk}:\n${result.stderr}${result.stdout}`)
  }
  const digest = /certificate SHA-256 digest: (\S+)/.exec(result.stdout)?.[1] ?? 'unknown'
  console.log(`Signed APK verified, certificate SHA-256 ${digest}`)
  const badging = capture(join(tools, 'aapt2'), ['dump', 'badging', apk], env)
  const match = /versionCode='(\d+)' versionName='([^']+)'/.exec(badging)
  const code = match?.[1]
  const name = match?.[2]
  if (code === undefined || name === undefined) {
    fail(`Cannot read the version of ${apk}.`)
  }
  return { code: Number(code), name, digest }
}

/**
 * Checks the bundle's JAR signature and that the APK of the same build has its certificate.
 * @param {Jdk} jdk
 * @param {string} bundle
 * @param {string} apkDigest
 */
function verifyBundle(jdk, bundle, apkDigest) {
  if (!existsSync(bundle)) {
    fail(`No bundle at ${bundle}.`)
  }
  const verify = spawnSync(join(jdk.home, 'bin/jarsigner'), ['-verify', bundle], { encoding: 'utf8' })
  if (verify.status !== 0 || !verify.stdout.includes('jar verified')) {
    fail(`jarsigner does not verify ${bundle}:\n${verify.stderr}${verify.stdout}`)
  }
  const certs = capture(join(jdk.home, 'bin/keytool'), ['-printcert', '-jarfile', bundle])
  const prints = [...certs.matchAll(/SHA256: ([0-9A-F:]+)/g)].map((match) =>
    match[1]?.replaceAll(':', '').toLowerCase(),
  )
  if (prints.length !== 1 || prints[0] !== apkDigest) {
    fail(`The bundle is not signed with the APK's certificate ${apkDigest}.`)
  }
  console.log(`Signed bundle verified, certificate SHA-256 ${apkDigest}`)
}

/** @returns {NodeJS.ProcessEnv} */
function npmEnv() {
  // pnpm exports its own npm_config_* settings, which make npx warn about unknown config.
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('npm_config_')))
}

/**
 * @param {string} apk
 * @param {string} notes
 * @param {FirebaseConfig} config
 * @returns {string}
 */
function distribute(apk, notes, config) {
  const work = mkdtempSync(join(tmpdir(), 'seti-android-release-'))
  try {
    const notesFile = join(work, 'release-notes.txt')
    writeFileSync(notesFile, notes)
    const args = ['-y', FIREBASE_TOOLS, 'appdistribution:distribute', apk, '--non-interactive']
    args.push('--app', config.appId, '--testers', config.testers, '--release-notes-file', notesFile)
    const result = spawnSync('npx', args, {
      cwd: work,
      encoding: 'utf8',
      env: { ...npmEnv(), GOOGLE_APPLICATION_CREDENTIALS: config.credentials },
      stdio: ['inherit', 'pipe', 'inherit'],
    })
    process.stdout.write(result.stdout)
    if (result.status !== 0) {
      fail('Firebase App Distribution upload failed.')
    }
    return /https:\/\/console\.firebase\.google\.com\/[^\s?]+/.exec(result.stdout)?.[0] ?? ''
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * @param {string} tag
 * @param {string} title
 * @param {string} body
 */
function tagRelease(tag, title, body) {
  capture('git', ['tag', '-a', tag, '-m', title, '-m', body])
}

/**
 * @typedef {object} BuildSetup
 * @property {Jdk} jdk
 * @property {string} tools
 * @property {NodeJS.ProcessEnv} env
 * @property {string} sha
 * @property {number} code
 * @property {PastRelease[]} past
 */

/**
 * @param {Channel} channel
 * @returns {BuildSetup}
 */
function prepareBuild(channel) {
  if (capture('git', ['status', '--porcelain', '--', 'android']) !== '') {
    fail('android/ has uncommitted changes: commit them first so the release matches a commit.')
  }
  const head = capture('git', ['rev-parse', 'HEAD'])
  const code = Number(capture('git', ['rev-list', '--count', 'HEAD']))
  const past = pastReleases()
  checkVersionCode(past, code, head, channel)
  const jdk = findJdk()
  const sdk = findSdk()
  const env = {
    ...process.env,
    JAVA_HOME: jdk.home,
    ANDROID_HOME: sdk,
    PATH: [join(jdk.home, 'bin'), process.env.PATH].join(delimiter),
  }
  return { jdk, tools: buildTools(sdk), env, sha: head.slice(0, 9), code, past }
}

/**
 * @param {string[]} tasks
 * @param {number} code
 * @param {Jdk} jdk
 * @param {NodeJS.ProcessEnv} env
 */
function gradle(tasks, code, jdk, env) {
  rmSync(APK_DIR, { recursive: true, force: true })
  rmSync(BUNDLE_DIR, { recursive: true, force: true })
  execFileSync(
    join(ANDROID, 'gradlew'),
    [
      ...tasks,
      `-Pseti.versionCode=${String(code)}`,
      '-Porg.gradle.java.installations.auto-detect=false',
      `-Porg.gradle.java.installations.paths=${jdk.home}`,
    ],
    { cwd: ANDROID, env, stdio: 'inherit' },
  )
}

function releaseToFirebase() {
  const config = firebaseConfig()
  const { jdk, tools, env, sha, code, past } = prepareBuild('firebase')
  console.log(`Building versionCode ${String(code)} at ${sha} with JDK ${String(jdk.major)} (${jdk.home})`)
  gradle(['assembleRelease'], code, jdk, env)
  const apk = join(APK_DIR, 'app-release.apk')
  const version = verifyApk(tools, apk, env)
  if (version.code !== code) {
    fail(`The APK has versionCode ${String(version.code)}, expected ${String(code)}.`)
  }
  const last = past.find((release) => release.channel === 'firebase')?.tag
  const notes = releaseNotes(last, { ...version, sha })
  console.log(`Release notes:\n${notes}`)
  const link = distribute(apk, notes, config)
  const tag = `${TAG_PREFIX}v${version.name}-${String(version.code)}`
  tagRelease(tag, `Seti Android ${version.name} (${String(version.code)})`, link === '' ? notes : link)
  console.log(`Released ${version.name} (${String(version.code)}) as tag ${tag}`)
  if (link !== '') {
    console.log(link)
  }
}

/**
 * @param {{ track: string, listing: boolean, buildOnly: boolean }} options
 */
async function releaseToPlay({ track, listing, buildOnly }) {
  const apiTrack = PLAY_TRACKS.get(track) ?? fail(`Unknown track ${track}: use internal or closed.`)
  const keyFile = playCredentials({ upload: !buildOnly, build: true })
  const listings = listing ? readListings(LISTINGS) : []
  const { jdk, tools, env, sha, code, past } = prepareBuild('play')
  console.log(`Building versionCode ${String(code)} at ${sha} with JDK ${String(jdk.major)} (${jdk.home})`)
  gradle(['assembleRelease', 'bundleRelease'], code, jdk, env)
  const version = verifyApk(tools, join(APK_DIR, 'app-release.apk'), env)
  if (version.code !== code) {
    fail(`The build has versionCode ${String(version.code)}, expected ${String(code)}.`)
  }
  const bundle = join(BUNDLE_DIR, 'app-release.aab')
  verifyBundle(jdk, bundle, version.digest)
  if (buildOnly) {
    console.log(`Built ${bundle}; upload it in the Play Console.`)
    return
  }
  const last = past.find((release) => release.channel === 'play')?.tag
  const notes = releaseNotes(last, { ...version, sha })
  console.log(`Release notes:\n${notes}`)
  const release = { versionCode: code, name: `${version.name} (${String(code)})`, notes }
  const result = await publish({
    keyFile,
    packageName: PACKAGE_NAME,
    build: { track: apiTrack, bundle, release },
    listings,
    log: (line) => {
      console.log(line)
    },
  }).catch((/** @type {unknown} */ error) => fail(error instanceof Error ? error.message : String(error)))
  const tag = `${PLAY_TAG_PREFIX}v${version.name}-${String(code)}`
  tagRelease(tag, `Seti Android ${version.name} (${String(code)}) on Play ${track}`, notes)
  console.log(`Released ${version.name} (${String(code)}) to the ${track} track as tag ${tag}`)
  if (result.draft) {
    console.log('Play took it as a draft because the app has not been published yet: roll it out in the Play Console.')
  }
  if (!result.sentForReview) {
    console.log('Managed publishing holds the changes: send them for review in the Play Console.')
  }
}

async function updateListing() {
  const keyFile = playCredentials({ upload: true, build: false })
  const listings = readListings(LISTINGS)
  const result = await publish({
    keyFile,
    packageName: PACKAGE_NAME,
    listings,
    log: (line) => {
      console.log(line)
    },
  }).catch((/** @type {unknown} */ error) => fail(error instanceof Error ? error.message : String(error)))
  console.log(result.sentForReview ? 'Listing updated.' : 'Listing saved: send it for review in the Play Console.')
}

const { values } = parseArgs({
  options: {
    play: { type: 'boolean', default: false },
    track: { type: 'string', default: 'internal' },
    listing: { type: 'boolean', default: false },
    'build-only': { type: 'boolean', default: false },
  },
})

if (values.play) {
  await releaseToPlay({ track: values.track, listing: values.listing, buildOnly: values['build-only'] })
} else if (values.listing) {
  await updateListing()
} else {
  releaseToFirebase()
}
