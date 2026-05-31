import { Controller, Get, Inject, Res } from "@nestjs/common";
import { HealthService } from "./health.service.js";

interface StatusResponse {
  status: (code: number) => void;
}

@Controller("health")
export class HealthController {
  constructor(
    @Inject(HealthService)
    private readonly healthService: HealthService,
  ) {}

  @Get()
  async getHealth(@Res({ passthrough: true }) response: StatusResponse) {
    const health = await this.healthService.check();

    // 这里保留 Phase 2 的 HTTP 契约：依赖异常时返回 503，但响应体仍直接给前端展示依赖明细。
    response.status(health.status === "ok" ? 200 : 503);
    return health;
  }
}
