import json
import os
import urllib.request


class QdrantHttpClient:
    def __init__(self, base_url=None):
        self.base_url = (base_url or os.environ.get("QDRANT_URL") or "http://127.0.0.1:6333").rstrip("/")

    def upsert_point(self, collection_name, point):
        request = urllib.request.Request(
            f"{self.base_url}/collections/{collection_name}/points?wait=true",
            data=json.dumps({"points": [point]}).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="PUT",
        )
        try:
            urllib.request.urlopen(request)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"Qdrant upsert failed: HTTP {error.code}") from error
