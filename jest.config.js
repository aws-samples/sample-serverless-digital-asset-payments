module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test/unit'],
  testMatch: ['**/*.test.js'],
  collectCoverageFrom: [
    'lambda/**/*.js',
    'dist/lib/**/*.js',
    '!lambda/**/node_modules/**'
  ]
};