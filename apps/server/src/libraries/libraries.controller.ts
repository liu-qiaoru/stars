import { Body, Controller, Delete, Get, Inject, Param, Patch, Post } from "@nestjs/common";
import { LibrariesService } from "./libraries.service.js";

@Controller("libraries")
export class LibrariesController {
  constructor(
    @Inject(LibrariesService)
    private readonly librariesService: LibrariesService,
  ) {}

  @Post()
  createLibrary(@Body() body: { name: string; root_path: string }) {
    return this.librariesService.createLibrary(body);
  }

  @Get()
  listLibraries() {
    return this.librariesService.listLibraries();
  }

  @Get(":id")
  getLibrary(@Param("id") id: string) {
    return this.librariesService.getLibrary(id);
  }

  @Patch(":id/disable")
  disableLibrary(@Param("id") id: string) {
    return this.librariesService.disableLibrary(id);
  }

  @Delete(":id")
  deleteLibrary(@Param("id") id: string) {
    return this.librariesService.deleteLibrary(id);
  }

  @Post(":id/scan")
  scanLibrary(@Param("id") id: string) {
    return this.librariesService.createScanJob(id);
  }
}
