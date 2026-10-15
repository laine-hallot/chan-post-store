import { defineConfig, type UserConfig } from 'tsdown';

/**
 * Bundles the analysis scripts that run on the archive host, the same way a
 * source's prepare script is bundled: that host has a node binary and the
 * data, and no node_modules. See sources/<id>/tsdown.config.ts.
 *
 * One config per script, not one config with several entries: entries built
 * together share their common code as a separate chunk, and only the entry
 * file is copied to the archive host -- the scan then fails importing a
 * chunk that was never shipped.
 */
const scan = (name: string, entry: string): UserConfig => ({
  entry: { [name]: entry },
  // Everything inlined, including the cli package's readers and their
  // dependencies; only node: builtins stay external.
  noExternal: [/.*/],
  format: 'esm',
  platform: 'node',
  outDir: 'dist',
  // Not cleaned: the configs share dist/, and one cleaning it would delete
  // what another just built.
  clean: false,
});

export default defineConfig([
  scan('post-dates-scan', 'src/post-dates/scan.ts'),
  scan('post-map-scan', 'src/post-map/scan.ts'),
]);
