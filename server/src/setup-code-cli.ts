/** Prints a one-time code that enrolls a passkey from a browser not yet signed in. */
async function main(): Promise<void> {
  const { closeDatabase, openDatabase } = await import('./db.js')
  const { createSetupCode } = await import('./seti-auth.js')
  const { audit } = await import('./audit.js')
  try {
    await openDatabase()
    const { code, expires_at } = await createSetupCode()
    await audit.record({
      actor: 'system',
      kind: 'system.setup_code_created',
      subject_type: 'system',
      summary: 'Made a passkey setup code on the host',
      detail: { expires_at },
    })
    process.stdout.write(
      `Setup code: ${code}\n` +
        `It works once, until ${expires_at}. Open Seti, choose Setup code and enter it to add a passkey.\n`,
    )
  } finally {
    await closeDatabase()
  }
}

await main()
