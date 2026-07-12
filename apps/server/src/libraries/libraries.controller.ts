import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common'
import { LibrariesService } from './libraries.service.js'

@Controller('libraries')
export class LibrariesController {
  constructor(
    @Inject(LibrariesService)
    private readonly librariesService: LibrariesService,
  ) {}

  @Post()
  createLibrary(@Body() body: { name: string; root_path: string }) {
    return this.librariesService.createLibrary(body)
  }

  @Get()
  listLibraries() {
    return this.librariesService.listLibraries()
  }

  @Get(':id')
  getLibrary(@Param('id') id: string) {
    return this.librariesService.getLibrary(id)
  }

  @Get(':id/media')
  listMedia(@Param('id') id: string, @Query('limit') limit = '25', @Query('offset') offset = '0') {
    return this.librariesService.listMedia(id, {
      limit: this.parseInteger(limit, 'limit', { min: 1, max: 100 }),
      offset: this.parseInteger(offset, 'offset', { min: 0 }),
    })
  }

  @Patch(':id/disable')
  disableLibrary(@Param('id') id: string) {
    return this.librariesService.disableLibrary(id)
  }

  @Delete(':id')
  deleteLibrary(@Param('id') id: string) {
    return this.librariesService.deleteLibrary(id)
  }

  @Post(':id/scan')
  scanLibrary(@Param('id') id: string) {
    return this.librariesService.createScanJob(id)
  }

  private parseInteger(value: string, name: string, bounds: { min: number; max?: number }) {
    const parsed = Number(value)
    if (
      !Number.isInteger(parsed) ||
      parsed < bounds.min ||
      (bounds.max !== undefined && parsed > bounds.max) ||
      String(parsed) !== value
    ) {
      const range =
        bounds.max === undefined ? `at least ${bounds.min}` : `${bounds.min}-${bounds.max}`
      throw new BadRequestException(`${name} must be an integer in range ${range}`)
    }
    return parsed
  }
}
