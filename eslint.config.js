import { fileURLToPath } from 'node:url'
import { includeIgnoreFile } from '@eslint/config-helpers'
import js from '@eslint/js'
import { recommended as eslintComments } from '@eslint-community/eslint-plugin-eslint-comments/configs'
import { defineConfig } from 'eslint/config'
import prettier from 'eslint-config-prettier'
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'
import { importX } from 'eslint-plugin-import-x'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import { configs as reactHooksConfigs } from 'eslint-plugin-react-hooks'
import { reactRefresh } from 'eslint-plugin-react-refresh'
import { configs as sonarConfigs } from 'eslint-plugin-sonarjs'
import globals from 'globals'
import { configs as tsConfigs } from 'typescript-eslint'
import { commentStyle } from './eslint/comment-style.js'
import { modFences } from './eslint/mod-fence.js'
import { noRawColour } from './eslint/no-raw-colour.js'

export default defineConfig(
  includeIgnoreFile(fileURLToPath(new URL('.gitignore', import.meta.url))),
  { ignores: ['packages/mod-api/template/**', 'e2e/fixtures/mods/**'] },
  js.configs.recommended,
  tsConfigs.strictTypeChecked,
  tsConfigs.stylisticTypeChecked,
  sonarConfigs.recommended,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  eslintComments,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({
          project: ['tsconfig.json', '*/tsconfig.json', 'packages/*/tsconfig.json', 'mods/*/tsconfig.json'],
          noWarnOnMultipleProjects: true,
        }),
      ],
    },
    plugins: { seti: { rules: { 'comment-style': commentStyle, 'no-raw-colour': noRawColour } } },
    rules: {
      'seti/comment-style': 'error',
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
      '@eslint-community/eslint-comments/no-unused-disable': 'error',
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',

      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
      'no-console': 'error',
      'no-param-reassign': ['error', { props: true, ignorePropertyModificationsFor: ['ctx'] }],
      'no-nested-ternary': 'error',
      'no-implicit-coercion': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'Use a union of string literals instead of an enum.' },
        { selector: 'ForInStatement', message: 'Use for...of over Object.keys/entries instead.' },
      ],
      'object-shorthand': 'error',
      'prefer-template': 'error',
      'no-else-return': ['error', { allowElseIf: false }],
      complexity: ['error', 15],
      'max-depth': ['error', 4],
      'max-params': ['error', 4],
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],

      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        { allowString: false, allowNumber: false, allowNullableObject: true },
      ],
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/promise-function-async': 'error',
      '@typescript-eslint/require-array-sort-compare': 'error',

      'import-x/no-cycle': 'error',
      'import-x/no-default-export': 'error',
      'import-x/no-extraneous-dependencies': 'error',
      'import-x/no-mutable-exports': 'error',
      'import-x/no-self-import': 'error',
      'import-x/no-useless-path-segments': 'error',
      'import-x/first': 'error',
      'import-x/newline-after-import': 'error',
      'import-x/no-duplicates': ['error', { 'prefer-inline': true }],
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
          pathGroups: [{ pattern: '@/**', group: 'internal' }],
          alphabetize: { order: 'asc' },
          'newlines-between': 'never',
        },
      ],

      'sonarjs/prefer-read-only-props': 'off',
      'sonarjs/todo-tag': 'error',
      'sonarjs/fixme-tag': 'error',
    },
  },
  {
    files: ['server/**/*.ts', 'shared/**/*.ts', 'e2e/**/*.ts', 'scripts/**', 'eslint/**', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['scripts/**'],
    rules: { 'no-console': 'off', 'sonarjs/no-os-command-from-path': 'off' },
  },
  ...modFences(new URL('mods', import.meta.url)),
  {
    files: ['ui/**/*.{ts,tsx}', 'mods/**/*.tsx'],
    extends: [reactHooksConfigs.flat['recommended-latest'], reactRefresh.configs.vite(), jsxA11y.flatConfigs.strict],
    languageOptions: { globals: globals.browser },
    rules: {
      'react-refresh/only-export-components': 'error',
      'seti/no-raw-colour': 'error',
    },
  },
  {
    files: ['ui/src/**/*.{ts,tsx}'],
    ignores: ['ui/src/components/find/**', 'ui/src/components/ui/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/components/ui/textarea',
              message: 'Use FindableTextarea, or PlainTextarea for a secret or the terminal line.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['mods/*/ui.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    files: [
      'ui/src/lib/agent-color.test.ts',
      'ui/src/components/theme/registry.test.ts',
      'ui/src/components/theme/themes.test.ts',
      'ui/src/mods/theme-mods.test.ts',
      'ui/src/components/palette/places.test.ts',
      'ui/src/panels/tasks/agent-list.test.ts',
    ],
    rules: { 'seti/no-raw-colour': 'off' },
  },
  {
    files: [
      'eslint.config.js',
      '**/vite.config.ts',
      '**/vitest.config.ts',
      '**/playwright.config.ts',
      'e2e/screenshots.config.ts',
      'e2e/tests/support/global-setup.ts',
      'knip.config.ts',
      'commitlint.config.js',
    ],
    rules: { 'import-x/no-default-export': 'off' },
  },
  {
    files: ['**/*.d.ts'],
    rules: { 'import-x/no-default-export': 'off' },
  },
  {
    files: ['**/*.test.ts'],
    rules: { 'max-lines': 'off' },
  },
  prettier,
  { rules: { curly: ['error', 'all'] } },
)
