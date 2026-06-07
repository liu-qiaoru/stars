import { existsSync } from 'node:fs'

export function findFirstExistingPath(paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path))
}
