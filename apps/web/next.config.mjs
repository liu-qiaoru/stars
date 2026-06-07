import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDir = dirname(fileURLToPath(import.meta.url))

/** @type {import("next").NextConfig} */
const nextConfig = {
  typedRoutes: false,
  turbopack: {
    root: resolve(currentDir, '../..'),
  },
}

export default nextConfig
