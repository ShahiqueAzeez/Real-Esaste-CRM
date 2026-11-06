/** Integration tests: need PostgreSQL (TEST_DATABASE_URL) and Redis (TEST_REDIS_URL). Run in band. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: 'test/.*\\.int-spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', isolatedModules: true }] },
  globalSetup: '<rootDir>/test/setup/global-setup.ts',
  setupFiles: ['<rootDir>/test/setup/env.ts'],
  testTimeout: 60000,
};
