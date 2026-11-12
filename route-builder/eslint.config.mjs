import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default [
  {
    ignores: [
      'dist/**',
      'dist-server/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      boundaries,
    },
    settings: {
      'boundaries/root-path': __dirname,
      'boundaries/include': ['server/**/*', 'src/**/*', 'e2e/**/*'],
      'boundaries/elements': [
        {
          type: 'lambda',
          pattern: 'server/lambdas/*',
          capture: ['lambdaName'],
          partialMatch: false,
        },
        {
          type: 'ai-provider',
          pattern: 'server/services/ai/*',
          capture: ['providerName'],
          partialMatch: false,
        },
        { type: 'ai-core', pattern: 'server/services/ai', partialMatch: false },
        { type: 'scout', pattern: 'server/services/scout', partialMatch: false },
        { type: 'server-service', pattern: 'server/services', partialMatch: false },
        { type: 'server-route', pattern: 'server/routes', partialMatch: false },
        { type: 'server-hook', pattern: 'server/hooks', partialMatch: false },
        { type: 'server-type', pattern: 'server/types', partialMatch: false },
        { type: 'server-test-helper', pattern: 'server/test-helpers', partialMatch: false },
        { type: 'frontend', pattern: 'src', partialMatch: false },
        { type: 'e2e', pattern: 'e2e', partialMatch: false },
      ],
      'boundaries/files': [
        { category: 'test', pattern: '**/*.test.{ts,tsx,js,jsx}' },
        { category: 'test-helper', pattern: '{server,src}/test-helpers/**' },
        { category: 'ai-registry', pattern: 'server/services/ai/aiRegistry.ts' },
        { category: 'server-entry', pattern: 'server/*.ts' },
      ],
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          noWarnOnMultipleProjects: true,
          project: [
            path.join(__dirname, 'tsconfig.json'),
            path.join(__dirname, 'tsconfig.server.json'),
            path.join(__dirname, 'tsconfig.test.json'),
            path.join(__dirname, 'tsconfig.test.server.json'),
          ],
        },
        node: true,
      },
    },
    rules: {
      'boundaries/no-unknown-files': 'error',
      'boundaries/no-unknown-dependencies': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            // Standalone Lambdas: only import from own subfolder, shared services/types, or ai-core;
            // never import from other lambda subfolders or Fastify server/routes/hooks.
            {
              from: { element: { type: 'lambda' } },
              allow: {
                to: [
                  {
                    element: {
                      type: 'lambda',
                      captured: { lambdaName: '{{ from.element.captured.lambdaName }}' },
                    },
                  },
                  { element: { types: ['server-service', 'ai-core', 'server-type'] } },
                ],
              },
            },
            {
              from: {
                element: {
                  type: 'lambda',
                  captured: { lambdaName: 'refreshBedrockPricing' },
                },
              },
              allow: {
                to: {
                  element: {
                    type: 'ai-provider',
                    captured: { providerName: 'bedrock' },
                  },
                },
              },
            },
            {
              from: { element: { type: 'lambda' }, file: { categories: 'test' } },
              allow: { to: { element: { type: 'server-test-helper' } } },
            },

            // AI Provider Adapter Seam: only aiRegistry.ts (and tests/test-helpers) may import concrete adapters
            {
              from: { file: { categories: 'ai-registry' } },
              allow: { to: { element: { type: 'ai-provider' } } },
            },
            {
              from: { element: { type: 'ai-provider' } },
              allow: {
                to: [
                  {
                    element: {
                      type: 'ai-provider',
                      captured: { providerName: '{{ from.element.captured.providerName }}' },
                    },
                  },
                  { element: { types: ['ai-core', 'server-service', 'server-type'] } },
                ],
              },
            },
            {
              from: { element: { type: 'ai-core' } },
              allow: { to: { element: { types: ['ai-core', 'server-type'] } } },
            },

            // Fastify server runtime & domain services
            {
              from: { file: { categories: 'server-entry' } },
              allow: {
                to: [
                  { file: { categories: 'server-entry' } },
                  {
                    element: {
                      types: ['server-route', 'server-hook', 'server-service', 'server-type'],
                    },
                  },
                ],
              },
            },
            {
              from: { element: { type: 'server-route' } },
              allow: {
                to: {
                  element: {
                    types: [
                      'server-route',
                      'server-service',
                      'ai-core',
                      'scout',
                      'server-hook',
                      'server-type',
                    ],
                  },
                },
              },
            },
            {
              from: { element: { type: 'server-hook' } },
              allow: {
                to: { element: { types: ['server-hook', 'server-service', 'server-type'] } },
              },
            },
            {
              from: { element: { type: 'scout' } },
              allow: {
                to: {
                  element: { types: ['scout', 'server-service', 'ai-core', 'server-type'] },
                },
              },
            },
            {
              from: { element: { type: 'server-service' } },
              allow: {
                to: {
                  element: { types: ['server-service', 'ai-core', 'scout', 'server-type'] },
                },
              },
            },

            // Backend tests & test helpers
            {
              from: {
                element: {
                  types: [
                    'ai-provider',
                    'ai-core',
                    'scout',
                    'server-service',
                    'server-route',
                    'server-hook',
                  ],
                },
                file: { categories: 'test' },
              },
              allow: {
                to: [
                  { file: { categories: 'server-entry' } },
                  { element: { types: ['ai-provider', 'scout', 'server-test-helper'] } },
                ],
              },
            },
            {
              from: { element: { type: 'server-test-helper' } },
              allow: {
                to: {
                  element: {
                    types: ['ai-provider', 'ai-core', 'scout', 'server-service', 'server-type'],
                  },
                },
              },
            },

            // Frontend & E2E
            {
              from: { element: { type: 'frontend' } },
              allow: { to: { element: { type: 'frontend' } } },
            },
            {
              from: { element: { type: 'e2e' } },
              allow: { to: { element: { types: ['e2e', 'frontend'] } } },
            },
          ],
        },
      ],
    },
  },
];
