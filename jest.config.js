/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/test'],
    testMatch: ['**/*.spec.ts'],
    testTimeout: 60000,
    maxWorkers: 1,
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov', 'json-summary'],
    collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/index.ts', '!src/nest.ts', '!src/fastify.ts'],
    coverageThreshold: {
        global: {
            statements: 90,
        },
    },
};
