import type {
  indexProfiles,
  jobStatuses,
  jobTypes,
  mediaAssetTypes,
  mediaTypes,
  vectorCollectionNames,
} from "../constants/index.js";

export type JobType = (typeof jobTypes)[number];
export type JobStatus = (typeof jobStatuses)[number];
export type MediaType = (typeof mediaTypes)[number];
export type MediaAssetType = (typeof mediaAssetTypes)[number];
export type VectorCollectionName = (typeof vectorCollectionNames)[number];
export type IndexProfile = (typeof indexProfiles)[number];
