import { Controller, Get, Inject, Param } from '@nestjs/common'
import { MediaService } from './media.service.js'

@Controller('media')
export class MediaController {
  constructor(
    @Inject(MediaService)
    private readonly mediaService: MediaService,
  ) {}

  @Get(':id')
  getMedia(@Param('id') id: string) {
    return this.mediaService.getMedia(id)
  }
}
