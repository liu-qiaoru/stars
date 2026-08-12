import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, test } from 'vitest'

type RouteRule = {
  entry: Array<{ source: string; pattern: RegExp }>
  return?: Array<{ source: string; pattern: RegExp }>
}

// 每个可访问 page.tsx 都必须在此声明“用户从哪里进入”和“如何返回”。
// 测试会自动扫描 apps/web/app；因此新增页面却忘记声明规则时必然失败，
// 不会像手写路由列表那样静默漏掉孤立路由。
const rules: Record<string, RouteRule> = {
  '/': { entry: [{ source: 'app/page.tsx', pattern: /redirect\('\/search'\)/ }] },
  '/agent': shellRule('/agent'),
  '/evaluation': shellRule('/evaluation'),
  '/evaluation/phase9a-c2': {
    entry: [{ source: 'components/evaluation-workspace.tsx', pattern: /\/evaluation\/phase9a-c2/ }],
    return: [{ source: 'app/evaluation/phase9a-c2/page.tsx', pattern: /\/evaluation/ }],
  },
  '/evaluation/reports': {
    entry: [{ source: 'components/evaluation-workspace.tsx', pattern: /\/evaluation\/reports/ }],
    return: [
      { source: 'components/evaluation-reports-workspace.tsx', pattern: /href="\/evaluation"/ },
    ],
  },
  '/evaluation/runs/[id]': {
    entry: [
      {
        source: 'components/evaluation-workspace.tsx',
        pattern: /\/evaluation\/runs\/\$\{run\.id\}/,
      },
      {
        source: 'components/evaluation-reports-workspace.tsx',
        pattern: /\/evaluation\/runs\/\$\{run\.id\}/,
      },
    ],
    return: [
      { source: 'app/evaluation/runs/[id]/page.tsx', pattern: /href="\/evaluation"/ },
      { source: 'app/evaluation/runs/[id]/page.tsx', pattern: /href="\/evaluation\/reports"/ },
    ],
  },
  '/jobs': shellRule('/jobs'),
  '/libraries': shellRule('/libraries'),
  '/media/[id]': {
    entry: [
      { source: 'components/search-workspace.tsx', pattern: /\/media\/\$\{/ },
      { source: 'components/library-workspace.tsx', pattern: /\/media\/\$\{/ },
    ],
    return: [{ source: 'app/media/[id]/page.tsx', pattern: /href="\/(search|libraries)"/ }],
  },
  '/search': shellRule('/search'),
  '/settings': shellRule('/settings'),
}

describe('user-visible page entry completeness', () => {
  test('discovers every app page and requires a visible entry plus return path', async () => {
    const discovered = await discoverPageRoutes(resolve('app'))
    expect(Object.keys(rules).sort()).toEqual(discovered.sort())

    for (const [route, rule] of Object.entries(rules)) {
      const entryMatches = await Promise.all(
        rule.entry.map(async (check) => check.pattern.test(await source(check.source))),
      )
      expect(entryMatches.some(Boolean), `${route} has no visible entry`).toBe(true)
      for (const check of rule.return ?? []) {
        expect(await source(check.source), `${route} is missing ${check.pattern}`).toMatch(
          check.pattern,
        )
      }
    }
  })
})

function shellRule(route: string): RouteRule {
  return {
    entry: [{ source: 'components/app-shell.tsx', pattern: new RegExp(`['"]${route}['"]`) }],
    return: [{ source: 'components/app-shell.tsx', pattern: new RegExp(`['"]${route}['"]`) }],
  }
}

async function discoverPageRoutes(root: string) {
  const files = await walk(root)
  return files
    .filter((path) => path.endsWith(`${sep}page.tsx`) || path === join(root, 'page.tsx'))
    .map((path) => {
      const relativePath = relative(root, path)
      const directory =
        relativePath === 'page.tsx' ? '' : relativePath.replace(new RegExp(`${sep}page\\.tsx$`), '')
      return directory ? `/${directory.split(sep).join('/')}` : '/'
    })
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? walk(path) : Promise.resolve([path])
    }),
  )
  return nested.flat()
}

async function source(path: string) {
  return readFile(resolve(path), 'utf8')
}
