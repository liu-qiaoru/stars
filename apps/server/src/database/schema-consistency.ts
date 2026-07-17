import { getTableColumns } from 'drizzle-orm'
import { jobs, mediaAssets, mediaFiles, vectorRefs, videoScenes } from './schema.js'

// 这份契约列出 Python worker 实际读写的表字段子集，配合 getMissingSchemaFields 在测试中
// 防止 Drizzle Schema 漂移导致 worker 写入失败。它不是完整 schema，只覆盖跨语言依赖。
export const pythonWorkerSchemaContract = {
  mediaFiles: [
    'id',
    'libraryId',
    'path',
    'mediaType',
    'sizeBytes',
    'mtimeMs',
    'durationSeconds',
    'width',
    'height',
    'codec',
    'indexStatus',
    // index_generation 用于阶段 3 的破坏性重索引识别；worker 读取并在 purge 时递增。
    'indexGeneration',
  ],
  // video_scenes 是阶段 2 新增的场景身份表；worker 在场景检测时写入，搜索/回表时读取。
  videoScenes: [
    'id',
    'fileId',
    'sceneKey',
    'startTimeSeconds',
    'endTimeSeconds',
    'detectionStrategy',
    'strategyFingerprint',
    'indexGeneration',
  ],
  mediaAssets: [
    'id',
    'fileId',
    'assetType',
    'path',
    // scene_id 是正式外键，视频帧与视频 caption 引用真实 video_scenes 行。
    'sceneId',
    'startTimeSeconds',
    'endTimeSeconds',
    'contentHash',
    'textContent',
  ],
  vectorRefs: [
    'id',
    'assetId',
    'fileId',
    'libraryId',
    'collectionName',
    'pointId',
    'modelName',
    'modelVersion',
    'vectorKind',
    'vectorDim',
    'contentHash',
    'indexProfile',
    'status',
  ],
  jobs: [
    'id',
    'jobType',
    'status',
    'progress',
    'inputJson',
    'resultJson',
    'errorMessage',
    // 结构化错误码与技术诊断（场景检测失败等确定性错误使用）。
    'errorCode',
    'errorDetailsJson',
    // 单文件媒体任务的外键；多文件任务（scan_library/verify_multi_frame_search）可空。
    'fileId',
    'heartbeatAt',
    'lockedBy',
    'lockedAt',
    'timeoutSeconds',
  ],
} as const

const tableColumns = {
  mediaFiles: getTableColumns(mediaFiles),
  videoScenes: getTableColumns(videoScenes),
  mediaAssets: getTableColumns(mediaAssets),
  vectorRefs: getTableColumns(vectorRefs),
  jobs: getTableColumns(jobs),
}

export function getMissingSchemaFields(contract: typeof pythonWorkerSchemaContract) {
  return Object.entries(contract).flatMap(([tableName, requiredFields]) => {
    const actualFields = tableColumns[tableName as keyof typeof tableColumns]
    return requiredFields
      .filter((field) => !(field in actualFields))
      .map((field) => `${tableName}.${field}`)
  })
}
