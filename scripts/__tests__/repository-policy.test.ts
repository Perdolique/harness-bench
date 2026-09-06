import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXPECTED_TOOLCHAIN, TOOL_COMMANDS, type ToolCommand } from '../toolchain.ts'

const root = resolve(import.meta.dirname, '../..')

const manifestOnlyWorkspaceManifests = [
  ['packages/results/package.json', '@harness-bench/results'],
  ['packages/statistics/package.json', '@harness-bench/statistics'],
  ['packages/reporting/package.json', '@harness-bench/reporting']
] as const

const expectedActions = [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'voidzero-dev/setup-vp@49c3e4e92c52e7f8392712a9267bbe71c5ab30e5',
  'actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97',
  'astral-sh/setup-uv@20cfd1bf945f4377ade1205e4dbc17946fc9a30d'
] as const

const expectedScripts = {
  benchctl: 'node apps/benchctl/src/cli.ts',

  check:
    'worsier --check . && markdownlint-cli2 && uv run ruff format --check .planning && oxlint --deny-warnings . && uv run ruff check --select E4,E7,E9,F,I .planning && tsc --noEmit && node --experimental-strip-types packages/schemas/scripts/generate-json-schemas.ts --check && vitest run --exclude ".pnpm-store/**" --exclude "spikes/harbor-codex-subscription/fixture/**" --exclude "fixtures/order-receipt/**" --exclude "benchmark/tasks/order-receipt/solutions/**" --exclude "benchmark/tasks/order-receipt/verifier/**" && python3 .planning/test_sync_github.py && python3 .planning/validate.py && node scripts/verify-toolchain.ts',

  format:
    'worsier --write . && uv run ruff format .planning',

  'format:check':
    'worsier --check . && uv run ruff format --check .planning',

  lint:
    'markdownlint-cli2 && oxlint --deny-warnings . && uv run ruff check --select E4,E7,E9,F,I .planning',

  'lint:markdown': 'markdownlint-cli2',

  'schemas:check':
    'node --experimental-strip-types packages/schemas/scripts/generate-json-schemas.ts --check',

  'schemas:generate':
    'node --experimental-strip-types packages/schemas/scripts/generate-json-schemas.ts',

  'spike:issue-2':
    'node --experimental-strip-types spikes/harbor-codex-subscription/run.ts',

  'spike:issue-2:check':
    'vitest run spikes/harbor-codex-subscription/__tests__ && node --experimental-strip-types spikes/harbor-codex-subscription/check.ts',

  'task:canonical:check':
    'node --experimental-strip-types scripts/canonical-task-check.ts',

  test:
    'vitest run --exclude ".pnpm-store/**" --exclude "spikes/harbor-codex-subscription/fixture/**" --exclude "fixtures/order-receipt/**" --exclude "benchmark/tasks/order-receipt/solutions/**" --exclude "benchmark/tasks/order-receipt/verifier/**"',

  'test:planning': 'python3 .planning/test_sync_github.py',
  typecheck: 'tsc --noEmit',
  'validate:planning': 'python3 .planning/validate.py',
  'verify:toolchain': 'node scripts/verify-toolchain.ts'
} as const

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Record<
    string,
    unknown
  >
}

function readToml(path: string): Record<string, unknown> {
  const parser = [
    'import json, pathlib, sys, tomllib',
    'with pathlib.Path(sys.argv[1]).open("rb") as source:',
    '    print(json.dumps(tomllib.load(source)))'
  ].join('\n')

  const output = execFileSync('python3', ['-c', parser, resolve(root, path)], {
    encoding: 'utf8'
  })

  return JSON.parse(output) as Record<string, unknown>
}

function renderToolCommand(toolCommand: ToolCommand): string {
  const command = [toolCommand.command, ...toolCommand.args].join(' ')

  const environment = Object.entries(toolCommand.environment ?? {})
    .map(([name, value]) => `${name}=${value}`)
    .join(' ')

  return `${environment} ${command}`.trim()
}

function providerPolicyViolations(sources: readonly string[]): string[] {
  const checks = [
    ['GitHub secret reference', /\bsecrets\./i],
    [
      'provider credential reference',
      /\b(?:OPENAI|ANTHROPIC|GEMINI|CODEX)_(?:API_KEY|ACCESS_TOKEN|AUTH_JSON_PATH)\b/i
    ],
    ['Codex provider command', /\bcodex\s+exec\b/i],
    ['Harbor execution command', /\bharbor\s+(?:run|job|jobs)\b/i]
  ] as const

  return checks
    .filter(([, pattern]) => sources.some((source) => pattern.test(source)))
    .map(([message]) => message)
}

describe('repository skeleton', () => {
  it('lints every Markdown file without a line-length limit', () => {
    expect(readJson('.markdownlint-cli2.jsonc')).toEqual({
      $schema:
        './node_modules/markdownlint-cli2/schema/markdownlint-cli2-config-schema.json',

      config: {
        'line-length': false
      },

      gitignore: true,
      globs: ['**/*.md'],

      overrides: [
        {
          filter: [
            '.github/pull_request_template.md',
            'benchmark/tasks/order-receipt/instruction.md',
            'spikes/harbor-codex-subscription/task/instruction.md'
          ],

          config: {
            'first-line-heading': false
          },

          combine: 'merge'
        },
        {
          filter: ['BOOTSTRAP_PLAN.md'],

          config: {
            'ol-prefix': false
          },

          combine: 'merge'
        }
      ]
    })
  })

  it('pins every runtime and direct tool dependency exactly', () => {
    const manifest = readJson('package.json')
    const pyproject = readToml('pyproject.toml')

    expect(readFileSync(resolve(root, '.node-version'), 'utf8').trim()).toBe(
      EXPECTED_TOOLCHAIN.node
    )

    expect(readFileSync(resolve(root, '.python-version'), 'utf8').trim()).toBe(
      EXPECTED_TOOLCHAIN.python
    )

    expect(manifest.packageManager).toBe(`pnpm@${EXPECTED_TOOLCHAIN.pnpm}`)

    expect(manifest.engines).toEqual({
      node: EXPECTED_TOOLCHAIN.node,
      pnpm: EXPECTED_TOOLCHAIN.pnpm
    })

    expect(manifest.devDependencies).toEqual({
      '@openai/codex': EXPECTED_TOOLCHAIN.codex,
      '@types/node': '26.4.1',
      'markdownlint-cli2': '0.23.2',
      oxlint: '1.81.0',
      typescript: '7.0.2',
      vitest: '5.0.0',
      worsier: '3.5.0'
    })

    expect(pyproject).toMatchObject({
      project: {
        'requires-python': `==${EXPECTED_TOOLCHAIN.python}`,
        dependencies: [`harbor==${EXPECTED_TOOLCHAIN.harbor}`]
      },

      'dependency-groups': {
        dev: ['ruff==0.16.6']
      },

      tool: {
        uv: {
          package: false,
          'required-version': `==${EXPECTED_TOOLCHAIN.uv}`
        }
      }
    })
  })

  it('keeps unimplemented workspace packages manifest-only', () => {
    for (const [path, name] of manifestOnlyWorkspaceManifests) {
      const manifest = readJson(path)

      expect(manifest).toEqual({
        name,
        version: '0.0.0',
        private: true,
        type: 'module'
      })

      expect(manifest).not.toHaveProperty('bin')
      expect(manifest).not.toHaveProperty('exports')
      expect(manifest).not.toHaveProperty('dependencies')

      expect(readdirSync(resolve(root, dirname(path)))).toEqual([
        'package.json'
      ])
    }
  })

  it('exposes only the issue 5 harness core and thin CLI surfaces', () => {
    expect(readJson('packages/core/package.json')).toEqual({
      name: '@harness-bench/core',
      version: '0.0.0',
      private: true,
      type: 'module',
      exports: './src/index.ts',

      dependencies: {
        '@harness-bench/schemas': 'workspace:*',
        'smol-toml': '1.8.0',
        valibot: '1.4.2'
      }
    })

    expect(readJson('apps/benchctl/package.json')).toEqual({
      name: '@harness-bench/benchctl',
      version: '0.0.0',
      private: true,
      type: 'module',
      bin: { benchctl: './src/cli.ts' },
      dependencies: { '@harness-bench/core': 'workspace:*' }
    })
  })

  it('exposes only the versioned schema package with exact dependencies', () => {
    const manifest = readJson('packages/schemas/package.json')

    expect(manifest).toEqual({
      name: '@harness-bench/schemas',
      version: '0.0.0',
      private: true,
      type: 'module',
      exports: './src/index.ts',
      dependencies: { valibot: '1.4.2' },
      devDependencies: { '@valibot/to-json-schema': '1.7.1' }
    })
  })

  it('ignores run state, generated environments, build output, and coverage', () => {
    const paths = [
      '.agent-stack-bench/runs/example/result.json',
      '.agent-stack-bench/generated/example.json',
      '.agent-stack-bench/environments/example/config.json',
      'packages/core/dist/index.js',
      'coverage/index.html',
      'fixtures/order-receipt/playwright-report/index.html',
      'fixtures/order-receipt/test-results/receipt/trace.zip',
      '.env.production'
    ]

    for (const path of paths) {
      expect(
        execFileSync('git', ['check-ignore', '-q', path], { cwd: root })
      ).toEqual(Buffer.alloc(0))
    }

    expect(() =>
      execFileSync('git', ['check-ignore', '-q', '.env.example'], {
        cwd: root
      })
    ).toThrow()
  })
})

describe('provider-free CI policy', () => {
  const workflowsDirectory = resolve(root, '.github/workflows')

  const workflowPaths = readdirSync(workflowsDirectory)
    .filter((path) => /\.ya?ml$/.test(path))
    .sort()

  const workflowSources = workflowPaths.map((path) =>
    readFileSync(resolve(workflowsDirectory, path), 'utf8')
  )

  const workflow = workflowSources[0] ?? ''
  const manifest = readJson('package.json')
  const scripts = manifest.scripts
  const scriptSources = Object.values(expectedScripts)
  const toolCommandSources = TOOL_COMMANDS.map(renderToolCommand)

  const policySources = [
    ...workflowSources,
    ...scriptSources,
    ...toolCommandSources
  ]

  it('has exactly one provider-free workflow and the pinned script graph', () => {
    expect(workflowPaths).toEqual(['check.yml'])
    expect(scripts).toEqual(expectedScripts)
    expect(providerPolicyViolations(policySources)).toEqual([])
  })

  it('uses read-only permissions and pinned actions without persistent credentials', () => {
    expect(workflow).toMatch(/permissions:\n  contents: read/)
    expect(workflow).toContain('persist-credentials: false')
    expect(workflow).toContain('HARBOR_TELEMETRY: off')

    const actionReferences = [...workflow.matchAll(/^\s*- uses: (\S+)/gm)].map(
      (match) => match[1]
    )

    expect(actionReferences).toEqual(expectedActions)
    expect(workflow).toContain('version: 0.3.0')
    expect(workflow).toContain('node-version-file: .node-version')
    expect(workflow).toContain('run-install: false')

    for (const reference of actionReferences) {
      expect(reference).toMatch(/@[0-9a-f]{40}$/)
    }
  })

  it('runs only locked installation and the aggregate check', () => {
    const commands = [...workflow.matchAll(/^\s+run: (.+)$/gm)].map(
      (match) => match[1]
    )

    expect(commands).toEqual([
      'vp install --frozen-lockfile',
      'uv sync --locked',
      'vp run check'
    ])
  })

  it('disables caches and uploads no artifacts', () => {
    expect(workflow).toContain('enable-cache: false')
    expect(workflow).toContain('cache: false')
    expect(workflow).not.toMatch(/actions\/cache|upload-artifact/i)
  })

  it.each([
    ['Codex execution', ['run: codex exec --json task']],
    ['Harbor run', ['run: harbor run benchmark/task']],
    ['Harbor job', ['run: harbor jobs start benchmark/task']],
    ['credential', ['env:\n  CODEX_AUTH_JSON_PATH: /credentials/auth.json']],
    ['secret', ['env:\n  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}']],
    ['provider package script', ['check: vp run test && codex exec task']],
    ['separate provider workflow', [workflow, 'run: harbor job task']]
  ])('rejects a %s fixture', (_name, fixture) => {
    expect(providerPolicyViolations(fixture)).not.toEqual([])
  })
})
