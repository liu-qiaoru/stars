import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // 多个集成测试会并行创建并迁移独立 PGlite 数据库。迁移链增长后，满载运行可能略超
    // Vitest 默认 5 秒；10 秒仍能快速暴露挂起，同时避免把机器调度抖动误报为业务失败。
    testTimeout: 10_000,
  },
})
