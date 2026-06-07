import { Body, Controller, Inject, Post } from '@nestjs/common'
import { SearchService, type SearchRequest } from './search.service.js'

@Controller('search')
export class SearchController {
  constructor(
    @Inject(SearchService)
    private readonly searchService: SearchService,
  ) {}

  @Post()
  search(@Body() body: SearchRequest) {
    return this.searchService.search(body)
  }
}
