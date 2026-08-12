"""Worker 任务的结构化错误。

阶段 2 起，确定性失败（场景检测不可用、视频解码失败、非法边界等）不再静默回退，
而是抛出带稳定 error_code 的 JobError。WorkerRunner 捕获后把 error_code 和技术详情
写入 jobs.error_code / jobs.error_details_json，并令 jobs.status='failed'、
media_files.index_status='failed'，让 Jobs 页面能展示短错误、技术详情和修复后重试入口。
"""


class JobError(Exception):
    """带稳定错误码的 worker 任务失败。

    error_code: 机器可读的稳定标识（如 SCENE_DETECTOR_UNAVAILABLE），前端/日志按它分类。
    details:    可序列化为 JSON 的技术诊断（路径以外的字段，避免泄露本地媒体内容）。
    """

    def __init__(self, error_code, message, details=None):
        super().__init__(message)
        self.error_code = error_code
        self.message = message
        self.details = details or {}


class JobCancelled(Exception):
    """表示用户请求取消当前 Job，而不是媒体处理失败。

    CandidateEvidenceHandler 会在读取每帧和发布产物前检查数据库中的
    ``cancel_requested`` 状态。抛出这个异常后，WorkerRunner 将 Job 和关联证据
    一起标为 ``cancelled``，并由 handler 的 finally/异常清理路径删除临时文件。
    """
