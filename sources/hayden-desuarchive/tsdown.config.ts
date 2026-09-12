import { defineConfig } from 'tsdown';

/**
 * Bundles prepare.ts and everything it imports into one file, because the
 * archive host has no node_modules -- only the bundle and a node binary get
 * copied there.
 */
export default defineConfig({
  entry: ['prepare.ts'],
  // EVERYTHING is inlined. tsdown externalises `dependencies` by default,
  // which would leave the bundle importing `staging-html` -- or its own
  // node-html-parser -- from a node_modules that does not exist on the
  // archive host. Only node: builtins stay external, as they should.
  noExternal: [/.*/],
  format: 'esm',
  platform: 'node',
  outDir: 'dist',
  clean: true,
});
