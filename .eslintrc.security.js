module.exports = {
  root: true,
  env: {
    node: true,
    es6: true,
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
  },
  rules: {
    // Security best practices without external plugins
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'no-script-url': 'error',
    'no-with': 'error',
    'no-caller': 'error',
    'no-extend-native': 'error',
    'no-proto': 'error',
    'no-iterator': 'error',
    'no-new-wrappers': 'error',
    'no-multi-str': 'error',
    'no-octal-escape': 'error',
    'no-sequences': 'error',
    'no-throw-literal': 'error',
    'no-void': 'error',
    radix: 'error',
    'wrap-iife': ['error', 'any'],
    yoda: 'error',
  },
  overrides: [
    {
      files: ['**/*.ts'],
      parser: '@typescript-eslint/parser',
      plugins: ['@typescript-eslint'],
      extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-non-null-assertion': 'error',
        '@typescript-eslint/prefer-as-const': 'error',
      },
    },
  ],
  ignorePatterns: ['node_modules/', 'dist/', 'cdk.out/', 'test/**/*', '*.d.ts'],
};
