export const SIGLIP_MODEL_NAME = 'google/siglip-base-patch16-224'
export const SIGLIP_MODEL_VERSION = 'siglip-base-patch16-224'
export const SIGLIP_VECTOR_DIM = 768
export const TEXT_EMBEDDING_MODEL_NAME = 'sentence-transformers'
export const TEXT_EMBEDDING_MODEL_VERSION = 'all-MiniLM-L6-v2'
export const TEXT_EMBEDDING_VECTOR_DIM = 384

export const VECTOR_COLLECTIONS = {
  image_vectors: {
    modality: 'image',
    vectorKind: 'image_embedding',
    modelName: SIGLIP_MODEL_NAME,
    modelVersion: SIGLIP_MODEL_VERSION,
    vectorDim: SIGLIP_VECTOR_DIM,
    distance: 'Cosine',
  },
  video_frame_vectors: {
    modality: 'video',
    vectorKind: 'frame_embedding',
    modelName: SIGLIP_MODEL_NAME,
    modelVersion: SIGLIP_MODEL_VERSION,
    vectorDim: SIGLIP_VECTOR_DIM,
    distance: 'Cosine',
  },
  video_segment_vectors: {
    modality: 'video',
    vectorKind: 'representative_frame_embedding',
    modelName: SIGLIP_MODEL_NAME,
    modelVersion: SIGLIP_MODEL_VERSION,
    vectorDim: SIGLIP_VECTOR_DIM,
    distance: 'Cosine',
  },
  audio_segment_vectors: {
    modality: 'audio',
    vectorKind: 'text_embedding',
    modelName: TEXT_EMBEDDING_MODEL_NAME,
    modelVersion: TEXT_EMBEDDING_MODEL_VERSION,
    vectorDim: TEXT_EMBEDDING_VECTOR_DIM,
    distance: 'Cosine',
  },
  text_chunk_vectors: {
    modality: 'text',
    vectorKind: 'text_embedding',
    modelName: TEXT_EMBEDDING_MODEL_NAME,
    modelVersion: TEXT_EMBEDDING_MODEL_VERSION,
    vectorDim: TEXT_EMBEDDING_VECTOR_DIM,
    distance: 'Cosine',
  },
} as const

export type VectorCollectionName = keyof typeof VECTOR_COLLECTIONS
export type VectorCollectionConfig = (typeof VECTOR_COLLECTIONS)[VectorCollectionName]
