import { prepareTestDatabases } from './test-db.js'

export async function setup(): Promise<void> {
  await prepareTestDatabases()
}
