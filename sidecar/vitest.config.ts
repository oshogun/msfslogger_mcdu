// vitest.config.ts - the sidecar's own suite, deliberately independent of the
// repo root's. `root` pins resolution here so the root config is never read and
// the root `npm test` never picks these files up.
const config: import('vitest/config').ViteUserConfig = {
  test: {
    root: __dirname,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    globals: false,
    restoreMocks: true,
    testTimeout: 5000,
    hookTimeout: 5000,
    reporters: ['default'],
    isolate: true,
  },
};

module.exports = config;
