import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Controller, Get, Headers, Inject, NotFoundException, Param, Res } from '@nestjs/common'
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

  @Get(':id/content')
  async getMediaContent(
    @Param('id') id: string,
    @Headers('range') range: string | undefined,
    @Res() response: any,
  ) {
    const media = await this.mediaService.getMediaContent(id)
    const fileStat = await this.statMediaFile(media.path)

    if (range) {
      const byteRange = parseRange(range, fileStat.size)
      if (byteRange) {
        response.status(206)
        response.set({
          'Accept-Ranges': 'bytes',
          'Content-Length': byteRange.end - byteRange.start + 1,
          'Content-Range': `bytes ${byteRange.start}-${byteRange.end}/${fileStat.size}`,
          'Content-Type': media.content_type,
        })
        return createReadStream(media.path, { start: byteRange.start, end: byteRange.end }).pipe(
          response,
        )
      }
    }

    response.status(200)
    response.set({
      'Accept-Ranges': 'bytes',
      'Content-Length': fileStat.size,
      'Content-Type': media.content_type,
    })
    return createReadStream(media.path).pipe(response)
  }

  private async statMediaFile(path: string) {
    try {
      const fileStat = await stat(path)
      if (!fileStat.isFile()) {
        throw new NotFoundException('Media content not found')
      }
      return fileStat
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error
      }
      throw new NotFoundException('Media content not found')
    }
  }
}

function parseRange(range: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  if (!match) {
    return null
  }

  const [, startText, endText] = match
  if (!startText && !endText) {
    return null
  }

  const start = startText ? Number.parseInt(startText, 10) : 0
  const end = endText ? Number.parseInt(endText, 10) : size - 1
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return null
  }
  return { start, end: Math.min(end, size - 1) }
}
