import {defineConfig} from 'tsup'

// One package, three entry points. The server entries carry the TextUnited token and the
// Sanity write token at runtime, so they must never be bundled into the Studio entry:
// keeping them as separate entries (and the Studio entry free of server imports) is what
// guarantees that.
export default defineConfig({
  entry: {
    'studio/index': 'src/studio/index.ts',
    'server/index': 'src/server/index.ts',
    'next/index': 'src/next/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  target: 'es2022',
  external: ['react', 'react/jsx-runtime', 'sanity', '@sanity/ui', '@sanity/icons', 'next'],
})
