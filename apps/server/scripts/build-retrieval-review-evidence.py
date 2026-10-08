"""只在本地复用 Worker 的公开处理入口生成盲评拼图；数据库提交替身只保留内存结果。

真实媒体路径从父进程 stdin 进入，不写日志或模型请求。生成文件限定于 .scratch；
仍使用 Worker 的 generation、场景、有效索引帧、渲染版本与字节指纹校验。
"""
import json
import sys
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker-py"))
from media_agent_worker.candidate_evidence import CandidateEvidenceHandler
from media_agent_worker.errors import JobError


class LocalReviewRepository:
    """生产库没有写接口；Worker 的完成提交仅记录到该隔离对象。"""

    def __init__(self, context):
        self.context = context
        self.evidence_id = str(uuid4())
        self.outputs = None

    def load_candidate_evidence_context(self, _job_input):
        return self.context

    def get_candidate_evidence_for_job(self, _job_id):
        return [{"id": self.evidence_id, "strategy": "contact_sheet_v1", "protocol_version": "candidate-evidence-v1"}]

    def complete_candidate_evidence_job(self, _job_id, outputs, _result):
        self.outputs = outputs


try:
    request = json.load(sys.stdin)
    root = Path(__file__).resolve().parents[3] / ".scratch/retrieval-quality/review-images"
    repository = LocalReviewRepository(request["context"])
    CandidateEvidenceHandler(repository, artifacts_root=root).handle(request["job"], job_id=str(uuid4()))
    print(json.dumps({"image": "review-images/" + Path(repository.outputs[0]["artifact_path"]).name,
                      "manifest": repository.outputs[0]["manifest"]}))
except Exception as error:
    # 字段化失败，不泄漏异常中可能包含的素材路径、正文或命令。
    print(json.dumps({"review_failed": True, "error_type": type(error).__name__,
                      "error_code": error.error_code if isinstance(error, JobError) else None}))
    sys.exit(1)
