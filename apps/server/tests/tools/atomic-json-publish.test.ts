import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  commitThenPublishPreparedJson,
  prepareAtomicJsonPublish,
} from '../../src/tools/atomic-json-publish.js'

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe('atomic JSON publication', () => {
  test('keeps the old target until publish and then replaces it with complete validated bytes', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'phase-f-json-publish-'))
    const target = resolve(directory, 'packet.json')
    await writeFile(target, '{"version":"old"}\n', 'utf8')

    const prepared = await prepareAtomicJsonPublish(target, '{"version":"new"}\n')

    expect(await readFile(target, 'utf8')).toBe('{"version":"old"}\n')
    expect(await readFile(prepared.temporaryPath, 'utf8')).toBe('{"version":"new"}\n')
    await prepared.publish()
    expect(await readFile(target, 'utf8')).toBe('{"version":"new"}\n')
  })

  test('discard removes a prepared file when the database transaction rolls back', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'phase-f-json-discard-'))
    const target = resolve(directory, 'packet.json')
    const prepared = await prepareAtomicJsonPublish(target, '{}\n')

    await prepared.discard()

    await expect(readFile(prepared.temporaryPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('keeps recovery bytes when COMMIT was sent but its acknowledgement is lost', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'phase-f-json-unknown-commit-'))
    const target = resolve(directory, 'packet.json')
    await writeFile(target, '{"version":"old"}\n', 'utf8')
    const prepared = await prepareAtomicJsonPublish(target, '{"version":"new"}\n')
    let publishCalled = false

    await expect(
      commitThenPublishPreparedJson({
        commit: async () => {
          throw new Error('connection lost after COMMIT was sent')
        },
        publish: async () => {
          publishCalled = true
          await prepared.publish()
        },
        temporaryPath: prepared.temporaryPath,
      }),
    ).rejects.toThrow(/commit outcome is unknown/)

    expect(publishCalled).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('{"version":"old"}\n')
    expect(await readFile(prepared.temporaryPath, 'utf8')).toBe('{"version":"new"}\n')
  })
})
