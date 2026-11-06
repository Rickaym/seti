/** git over https only, with no credential helper: the proxy authenticates GitHub requests. */
const GIT_CONFIG: [string, string][] = [
  ['credential.https://github.com.helper', ''],
  ['url.https://github.com/.insteadOf', 'git@github.com:'],
  ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
  ['push.default', 'current'],
]

export function gitEnv(): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(GIT_CONFIG.length), GIT_TERMINAL_PROMPT: '0' }
  for (const [index, [key, value]] of GIT_CONFIG.entries()) {
    env[`GIT_CONFIG_KEY_${String(index)}`] = key
    env[`GIT_CONFIG_VALUE_${String(index)}`] = value
  }
  return env
}
