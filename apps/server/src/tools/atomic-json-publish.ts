import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

/**
 * 在目标文件的同一目录准备完整临时文件。调用方应在数据库提交后调用 publish()；
 * 同文件系统 rename 是原子替换，因此读者只会看到旧版或完整新版，不会看到半截 JSON。
 * 若提交后 rename 失败，临时文件会保留，调用方可明确报告路径并安全重试发布。
 */
export async function prepareAtomicJsonPublish(outputPath: string, contents: string) {
  const targetPath = resolve(outputPath)
  const temporaryPath = resolve(
    dirname(targetPath),
    `.${basename(targetPath)}.${randomUUID()}.pending`,
  )
  await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' })
  // 写后读保证磁盘中的临时文件与内存中已通过 Schema 的 JSON 完全一致；短写或
  // 文件系统异常会在数据库提交前暴露，调用方仍可回滚事务。
  if ((await readFile(temporaryPath, 'utf8')) !== contents) {
    await unlink(temporaryPath)
    throw new Error('prepared candidate packet bytes do not match the validated JSON')
  }
  let published = false
  return {
    temporaryPath,
    targetPath,
    async publish() {
      await rename(temporaryPath, targetPath)
      published = true
    },
    async discard() {
      if (!published) await unlink(temporaryPath)
    },
  }
}

/**
 * COMMIT 是不可安全重试的边界：请求发出后即使确认响应丢失，数据库也可能已提交。
 * 此函数在该未知结果下保留 prepared 临时文件，既不发布也不删除，供维护者先按
 * 数据库指纹核验事实；只有收到明确提交确认后才原子发布目标文件。
 */
export async function commitThenPublishPreparedJson(input: {
  commit: () => Promise<void>
  publish: () => Promise<void>
  temporaryPath: string
}) {
  try {
    await input.commit()
  } catch (error) {
    throw new Error(
      `database commit outcome is unknown; keep ${input.temporaryPath} and verify the dataset fingerprint before publishing or deleting it`,
      { cause: error },
    )
  }
  try {
    await input.publish()
  } catch (error) {
    throw new Error(
      `database committed but candidate packet publication failed; recover from ${input.temporaryPath}`,
      { cause: error },
    )
  }
}
