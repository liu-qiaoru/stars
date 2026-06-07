export const VECTOR_COLLECTIONS = {
  image_vectors: {
    modality: 'image',
    vectorKind: 'image_embedding',
    modelName: 'mock',
    modelVersion: 'phase5',
    vectorDim: 512,
    distance: 'Cosine',
  },
  video_frame_vectors: {
    modality: 'video',
    vectorKind: 'frame_embedding',
    modelName: 'mock',
    modelVersion: 'phase5',
    vectorDim: 512,
    distance: 'Cosine',
  },
  video_segment_vectors: {
    modality: 'video',
    vectorKind: 'representative_frame_embedding',
    modelName: 'mock',
    modelVersion: 'phase5',
    vectorDim: 512,
    distance: 'Cosine',
  },
  audio_segment_vectors: {
    modality: 'audio',
    vectorKind: 'text_embedding',
    modelName: 'mock',
    modelVersion: 'phase5',
    vectorDim: 384,
    distance: 'Cosine',
  },
  text_chunk_vectors: {
    modality: 'text',
    vectorKind: 'text_embedding',
    modelName: 'mock',
    modelVersion: 'phase5',
    vectorDim: 384,
    distance: 'Cosine',
  },
} as const

export type VectorCollectionName = keyof typeof VECTOR_COLLECTIONS
export type VectorCollectionConfig = (typeof VECTOR_COLLECTIONS)[VectorCollectionName]
