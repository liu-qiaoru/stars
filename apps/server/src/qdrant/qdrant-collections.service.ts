import { Inject, Injectable } from "@nestjs/common";
import { SETTINGS, type Settings } from "../config/settings.js";
import { VECTOR_COLLECTIONS, type VectorCollectionConfig, type VectorCollectionName } from "./vector-collections.js";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

@Injectable()
export class QdrantCollectionsService {
  constructor(
    @Inject(SETTINGS) settingsOrUrl: Settings | string,
    private readonly fetcher: Fetcher = fetch,
    private readonly collections: Partial<Record<VectorCollectionName, VectorCollectionConfig>> = VECTOR_COLLECTIONS,
  ) {
    this.qdrantUrl =
      typeof settingsOrUrl === "string" ? settingsOrUrl.replace(/\/$/, "") : settingsOrUrl.qdrantUrl.replace(/\/$/, "");
  }

  private readonly qdrantUrl: string;

  async ensureCollections() {
    const created: string[] = [];
    const existing: string[] = [];

    for (const [name, config] of Object.entries(this.collections) as [VectorCollectionName, VectorCollectionConfig][]) {
      const collectionUrl = `${this.qdrantUrl}/collections/${name}`;
      const response = await this.fetcher(collectionUrl, { method: "GET" });
      if (response.ok) {
        existing.push(name);
        continue;
      }

      const createResponse = await this.fetcher(collectionUrl, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          vectors: {
            size: config.vectorDim,
            distance: config.distance,
          },
        }),
      });
      if (!createResponse.ok) {
        throw new Error(`Failed to create Qdrant collection ${name}: HTTP ${createResponse.status}`);
      }
      created.push(name);
    }

    return { created, existing };
  }
}
