// Lint is for what the type checker cannot see, not for style: Prettier owns formatting, and tsc already
// rejects unused names and unchecked indexes. What is left is promise handling — a promise nobody awaits loses
// its rejection, and an async callback handed to something that expects a plain function has its failure
// swallowed — which is exactly the class of bug a long-lived Host with background work cannot afford — plus the
// two rules React has that neither tsc nor the type system can express: where a hook may run, and what a hook's
// dependency list has to name.
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

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
      'packages/sandbox/windows-sandbox/native/',
    ],
  },
  {
    files: ['packages/**/*.ts', 'apps/**/*.ts', 'apps/**/*.tsx', 'tests/**/*.ts'],
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
    // The React layer only. Applied to the whole app it would read every `use*` helper as a hook; scoped here it
    // is about components and hooks and nothing else. A conditional hook is a correctness bug the type checker
    // cannot see, and a dependency list that omits a value is how a stale closure ships.
    files: ['apps/desktop/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
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
