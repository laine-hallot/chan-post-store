import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';
import perfectionist from 'eslint-plugin-perfectionist';
import js from '@eslint/js';

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.base],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
      },
    },
    plugins: { js, perfectionist },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],
      'prefer-destructuring': 'off',
      '@typescript-eslint/prefer-destructuring': [
        'warn',
        {
          VariableDeclarator: {
            array: false,
            object: true,
          },
        },
      ],
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/no-confusing-non-null-assertion': 'warn',
      '@typescript-eslint/prefer-as-const': 'warn',
      'prefer-arrow-callback': 'warn',
      'func-style': ['warn', 'expression', {}],
      'perfectionist/sort-imports': [
        'warn',
        {
          groups: [
            'type-import',
            'type-internal',
            'type-workspace',
            ['type-parent', 'type-sibling', 'type-index'],
            ['value-builtin', 'value-external'],
            'value-workspace',
            'value-internal',
            ['value-parent', 'value-sibling', 'value-index'],
            'ts-equals-import',
            'style',
            'unknown',
          ],
          customGroups: [
            {
              groupName: 'type-workspace',
              modifiers: ['type'],
              elementNamePattern: '^@chan-post-store/.*',
            },
            {
              groupName: 'value-workspace',
              modifiers: ['value'],
              elementNamePattern: '^@chan-post-store/*',
            },
          ],
        },
      ],
    },
  },
]);
