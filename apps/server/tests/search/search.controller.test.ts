import { Test } from "@nestjs/testing";
import { describe, expect, test, vi } from "vitest";
import { SearchController } from "../../src/search/search.controller.js";
import { SearchService } from "../../src/search/search.service.js";

describe("search controller", () => {
  test("POST /search body 交给 SearchService", async () => {
    const response = { limit: 3, offset: 0, groups: [] };
    const search = vi.fn().mockResolvedValue(response);
    const moduleRef = await Test.createTestingModule({
      controllers: [SearchController],
      providers: [
        {
          provide: SearchService,
          useValue: { search },
        },
      ],
    }).compile();
    const controller = moduleRef.get(SearchController);

    await expect(controller.search({ query: "red car", limit: 3 })).resolves.toBe(response);
    expect(search).toHaveBeenCalledWith({ query: "red car", limit: 3 });

    await moduleRef.close();
  });
});
