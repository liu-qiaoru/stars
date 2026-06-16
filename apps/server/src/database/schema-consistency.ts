import { getTableColumns } from 'drizzle-orm'
import { jobs, mediaAssets, mediaFiles, vectorRefs } from './schema.js'

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
  ],
  mediaAssets: [
    'id',
    'fileId',
    'assetType',
    'path',
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
    'heartbeatAt',
    'lockedBy',
    'lockedAt',
    'timeoutSeconds',
  ],
} as const

const tableColumns = {
  mediaFiles: getTableColumns(mediaFiles),
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
