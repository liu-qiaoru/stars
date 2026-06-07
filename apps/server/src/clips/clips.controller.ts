import { Body, Controller, Inject, Post } from '@nestjs/common'
import { ClipsService, type ExportClipRequest } from './clips.service.js'

@Controller('clips')
export class ClipsController {
  constructor(
    @Inject(ClipsService)
    private readonly clipsService: ClipsService,
  ) {}

  @Post('export')
  exportClip(@Body() body: ExportClipRequest) {
    return this.clipsService.exportClip(body)
  }
}
