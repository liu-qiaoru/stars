import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common'
import { CandidateEvidenceService } from './candidate-evidence.service.js'

interface ArtifactResponse {
  set: (headers: Record<string, string>) => void
}

@Controller('candidate-evidence')
export class CandidateEvidenceController {
  constructor(
    @Inject(CandidateEvidenceService)
    private readonly candidateEvidenceService: CandidateEvidenceService,
  ) {}

  @Post()
  createEvidence(@Body() body: unknown) {
    return this.candidateEvidenceService.createEvidence(body)
  }

  @Get()
  listEvidence(@Query() query: unknown) {
    return this.candidateEvidenceService.listEvidence(query)
  }

  @Post(':id/cancel')
  cancelEvidence(@Param('id') id: string) {
    return this.candidateEvidenceService.cancelEvidence(id)
  }

  @Get(':id/artifact')
  async getArtifact(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: ArtifactResponse,
  ) {
    const artifact = await this.candidateEvidenceService.getArtifact(id)
    response.set({
      'Content-Type': artifact.contentType,
      'Content-Disposition': `inline; filename="${artifact.filename}"`,
      'Cache-Control': 'private, no-store',
    })
    return new StreamableFile(artifact.content)
  }

  @Get(':id')
  getEvidence(@Param('id') id: string) {
    return this.candidateEvidenceService.getEvidence(id)
  }
}
