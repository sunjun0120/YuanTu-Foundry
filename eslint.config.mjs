// Lint is for what the type checker cannot see, not for style: Prettier owns formatting, and tsc already
// rejects unused names and unchecked indexes. What is left is promise handling — a promise nobody awaits loses
// its rejection, and an async callback handed to something that expects a plain function has its failure
// swallowed — which is exactly the class of bug a long-lived Host with background work cannot afford.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      'dist/',
      'artifacts/',
      'build/',
      'vendor/',
      '.scratch/',
      '.yuantu/',
      'packages/tools/windows-sandbox/native/',
    ],
  },
  {
    files: ['packages/**/*.ts', 'apps/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          // node:test registers a test and hands back a promise the runner already owns.
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite'] },
          ],
        },
      ],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  {
    // Fixture servers take async request handlers that catch their own errors, and some tests hand an async
    // callback to a void slot on purpose to prove the runtime survives it.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
    },
  },
);
