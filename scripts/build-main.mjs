import { build } from 'esbuild'
import { rm, mkdir } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outdir = path.join(root, 'dist', 'main')

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: process.env.NODE_ENV === 'development' ? 'inline' : false,
  minify: process.env.NODE_ENV === 'production',
  external: ['electron'],
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
}

await Promise.all([
  build({ ...shared, entryPoints: [path.join(root, 'electron/main.ts')], outfile: path.join(outdir, 'index.cjs') }),
  build({ ...shared, entryPoints: [path.join(root, 'electron/preload.ts')], outfile: path.join(outdir, 'preload.cjs') }),
])

console.log('[build-main] electron main + preload built ->', outdir)
