import json
import os
import urllib.request


class QdrantHttpClient:
    """Minimal Qdrant writer used by Python embedding jobs.

    TypeScript manages collection creation; Python only upserts points after model inference succeeds.
    """

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

    def delete_points(self, collection_name, point_ids):
        # 阶段 3 purge 用：按 point id 删除 Qdrant 点。删除不存在的点是 no-op，因此 purge
        # 重试时即使上一轮已删除也不会报错，保证幂等。
        if not point_ids:
            return 0
        request = urllib.request.Request(
            f"{self.base_url}/collections/{collection_name}/points/delete?wait=true",
            data=json.dumps({"points": point_ids}).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            urllib.request.urlopen(request)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"Qdrant delete failed: HTTP {error.code}") from error
        return len(point_ids)
