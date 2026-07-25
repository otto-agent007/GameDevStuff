import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      '.github/**',
      '.worktrees/**',
      '**/node_modules/**',
      '**/generated/**',
      '**/private/**',
      '**/test-results/**',
      '**/playwright-report/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      // The existing binary parsers and release compatibility paths intentionally use these patterns.
      'no-control-regex': 'off',
      'no-empty': 'off',
      'no-unsafe-finally': 'off',
      'no-unused-vars': 'off',
      // ESLint 10 newly enables this recommended rule; preserving error messages needs a dedicated refactor.
      'preserve-caught-error': 'off'
    }
  }
];
