import { Inject, Injectable } from '@nestjs/common'
import { DEPENDENCY_CHECKS, type DependencyChecks } from './dependency-checks.js'

export interface HealthResponse {
  status: 'ok' | 'error'
  dependencies: {
    database: 'ok' | 'error'
    qdrant: 'ok' | 'error'
  }
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DEPENDENCY_CHECKS)
    private readonly dependencyChecks: DependencyChecks,
  ) {}

  async check(): Promise<HealthResponse> {
    const [database, qdrant] = await Promise.all([
      this.dependencyChecks.database(),
      this.dependencyChecks.qdrant(),
    ])

    return {
      status: database === 'ok' && qdrant === 'ok' ? 'ok' : 'error',
      dependencies: {
        database,
        qdrant,
      },
    }
  }
}
