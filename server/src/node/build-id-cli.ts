import path from 'node:path'
import { nodeBuildId } from './build-id.js'

process.stdout.write(
  `${await nodeBuildId(path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../../..')))}\n`,
)
