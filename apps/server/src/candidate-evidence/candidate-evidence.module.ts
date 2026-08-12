import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module.js'
import { CandidateEvidenceController } from './candidate-evidence.controller.js'
import { CandidateEvidenceService } from './candidate-evidence.service.js'

@Module({
  imports: [DatabaseModule],
  controllers: [CandidateEvidenceController],
  providers: [CandidateEvidenceService],
  exports: [CandidateEvidenceService],
})
export class CandidateEvidenceModule {}
