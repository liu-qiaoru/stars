import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

describe('jobs styles', () => {
  test('keeps processing progress animation in the global stylesheet', () => {
    const css = readFileSync('app/globals.css', 'utf8')

    expect(css).toContain('.progress-track.processing')
    expect(css).toContain('@keyframes jobs-progress-processing')
    expect(css).toContain('min-width: 22px')
    expect(css).toContain('box-shadow: 0 0 0 1px #9fc9ff inset')
  })
})
