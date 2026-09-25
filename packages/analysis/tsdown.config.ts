import { defineConfig } from 'tsdown';

/**
 * Bundles the analysis scripts that run on the archive host, the same way a
 * source's prepare script is bundled: that host has a node binary and the
 * data, and no node_modules. See sources/<id>/tsdown.config.ts.
 */
export default defineConfig({
  entry: { 'post-dates-scan': 'src/post-dates/scan.ts' },
  // Everything inlined, including the cli package's readers and their
  // dependencies; only node: builtins stay external.
  noExternal: [/.*/],
  format: 'esm',
  platform: 'node',
  outDir: 'dist',
  clean: true,
});
