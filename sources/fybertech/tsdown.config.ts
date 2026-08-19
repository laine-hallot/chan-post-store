import { defineConfig } from 'tsdown';

/**
 * Bundles prepare.ts and everything it imports into one file, because the
 * archive host has no node_modules -- only the bundle and a node binary get
 * copied there.
 */
export default defineConfig({
  entry: ['prepare.ts'],
  // The workspace packages must be INLINED. tsdown externalises anything in
  // `dependencies` by default, which would leave the bundle importing
  // `staging-html` from a node_modules that does not exist on the archive
  // host. node: builtins stay external, as they should.
  noExternal: [/^staging-/, /^site-config-/],
  format: 'esm',
  platform: 'node',
  outDir: 'dist',
  clean: true,
});
