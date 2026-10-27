import path from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/dist/**'],
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'apps/web/src'),
      '@qiushui-airadar/config': path.resolve(
        import.meta.dirname,
        'packages/config/src/index.ts'
      ),
      '@qiushui-airadar/domain': path.resolve(
        import.meta.dirname,
        'packages/domain/src/index.ts'
      ),
      '@qiushui-airadar/runtime': path.resolve(
        import.meta.dirname,
        'packages/runtime/src/index.ts'
      ),
      '@qiushui-airadar/pipeline': path.resolve(
        import.meta.dirname,
        'packages/pipeline/src/index.ts'
      ),
      '@qiushui-airadar/service': path.resolve(
        import.meta.dirname,
        'apps/service/src/index.ts'
      ),
      '@qiushui-airadar/source-adapters': path.resolve(
        import.meta.dirname,
        'packages/source-adapters/src/index.ts'
      ),
    },
  },
})
