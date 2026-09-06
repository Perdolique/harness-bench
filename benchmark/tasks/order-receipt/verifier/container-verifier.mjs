import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { chmod, chown, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { dirname, resolve } from 'node:path'
import { inspectMaterializedTaskWorkspace, materializeTaskWorkspace } from '/opt/core/task.ts'
import { verifyWorkspaceArtifacts } from '/opt/core/task-artifacts.ts'

const sourceDigest = process.env.TASK_SOURCE_DIGEST
const baseCommit = process.env.TASK_BASE_COMMIT
const runId = process.env.HARBOR_RUN_ID ?? 'local-calibration-run'
const artifacts = '/evidence'
const verifierLogs = '/logs/verifier'
const trustedSource = '/trusted/source'
const runtimeModules = '/opt/task-runtime/node_modules'
const playwrightCli = resolve(runtimeModules, '@playwright/test/cli.js')
const viteCli = resolve(runtimeModules, 'vite/bin/vite.js')
const vitestCli = resolve(runtimeModules, 'vitest/vitest.mjs')
const vueTscCli = resolve(runtimeModules, 'vue-tsc/bin/vue-tsc.js')
const runtimeCacheNames = ['.vite', '.vite-temp', '.vue-global-types']

const requiredCandidateTests = {
  browser: /^tests\/e2e\/.+\.test\.ts$/,
  unit: /^src\/.+\.test\.ts$/
}

const trustedRegressionPaths = [
  'src/components/OrderCard.test.ts',
  'src/stores/orders.test.ts',
  'tests/e2e/order-details.test.ts'
]

const contractIds = [
  'availability',
  'selected-context',
  'analytics',
  'localization',
  'keyboard',
  'candidate-tests'
]

if (sourceDigest === undefined || baseCommit === undefined) {
  throw new Error('Verifier requires TASK_SOURCE_DIGEST and TASK_BASE_COMMIT')
}

function sha256(contents) {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`
}

function processIsActive(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const state = /^State:\s+([A-Z])/mu.exec(status)?.[1]
    const uid = Number(/^Uid:\s+(\d+)/mu.exec(status)?.[1])

    return uid === 1001 && state !== 'Z'
  } catch {
    return false
  }
}

function activeUntrustedProcessIds() {
  return readdirSync('/proc', { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter(processIsActive)
}

function terminateUntrustedProcesses() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const processIds = activeUntrustedProcessIds()

    if (processIds.length === 0) {
      return
    }

    for (const processId of processIds) {
      try {
        process.kill(processId, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') {
          throw error
        }
      }
    }
  }

  const remaining = activeUntrustedProcessIds()

  if (remaining.length > 0) {
    throw new Error(`Untrusted processes survived cleanup: ${remaining.join(', ')}`)
  }
}

function run(command, args, options = {}) {
  let result

  try {
    result = spawnSync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',

      env: {
        CI: '1',
        PATH: process.env.PATH,
        PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
        ...options.env
      },

      gid: options.untrusted ? 1001 : undefined,
      maxBuffer: 32 * 1024 * 1024,
      uid: options.untrusted ? 1001 : undefined
    })
  } finally {
    if (options.untrusted) {
      terminateUntrustedProcesses()
    }
  }

  return {
    command: [command, ...args].join(' '),
    detail: [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
    passed: options.expectFailure ? result.status !== 0 : result.status === 0,
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout
  }
}

function runBuild(workspace, home) {
  const typecheck = run(process.execPath, [vueTscCli, '--noEmit', '-p', resolve(workspace, 'tsconfig.json')], {
    cwd: workspace,
    env: { HOME: home },
    untrusted: true
  })

  if (!typecheck.passed) {
    return typecheck
  }

  return run(process.execPath, [viteCli, 'build', workspace], {
    cwd: workspace,
    env: { HOME: home },
    untrusted: true
  })
}

async function chownTree(path) {
  const metadata = await lstat(path)

  if (!metadata.isSymbolicLink()) {
    await chown(path, 1001, 1001)
  }

  if (metadata.isDirectory()) {
    for (const entry of await readdir(path)) {
      await chownTree(resolve(path, entry))
    }
  }
}

async function lockTree(path) {
  const metadata = await lstat(path)

  if (metadata.isSymbolicLink()) {
    return
  }

  if (metadata.isDirectory()) {
    for (const entry of await readdir(path)) {
      await lockTree(resolve(path, entry))
    }
  }

  await chown(path, 0, 0)
  await chmod(path, metadata.isDirectory() ? 0o555 : metadata.mode & 0o111 ? 0o555 : 0o444)
}

async function prepareUntrustedWorkspace(workspace, home) {
  await mkdir(home, { recursive: true })
  await symlink(runtimeModules, resolve(workspace, 'node_modules'), 'dir')
  await chownTree(workspace)
  await chownTree(home)
}

async function resetRuntimeCaches() {
  for (const name of runtimeCacheNames) {
    const path = resolve(runtimeModules, name)

    await rm(path, {
      force: true,
      recursive: true
    })

    await mkdir(path)
    await chownTree(path)
  }
}

async function copyCandidateTests(source, destination, paths) {
  for (const path of paths) {
    const target = resolve(destination, path)

    await mkdir(dirname(target), { recursive: true })
    await cp(resolve(source, path), target)
  }
}

function stageAndListChangedPaths(workspace) {
  execFileSync('git', ['-C', workspace, 'add', '--all'])

  return execFileSync(
    'git',
    ['-C', workspace, 'diff', '--cached', '--name-only', '--no-ext-diff', 'HEAD', '--'],
    { encoding: 'utf8' }
  )
    .split('\n')
    .filter(Boolean)
    .sort()
}

function scopeViolations(paths) {
  const allowed = [
    /^src\/components\/.+\.vue$/,
    /^src\/components\/.+\.test\.ts$/,
    /^src\/composables\/.+\.ts$/,
    /^src\/locales\/en\.ts$/,
    /^src\/pages\/OrderHistoryPage\.vue$/,
    /^tests\/e2e\/.+\.test\.ts$/
  ]

  return paths.flatMap((path) => {
    if (trustedRegressionPaths.includes(path)) {
      return [{
        path,
        reason: 'Trusted pristine regression tests must remain unchanged'
      }]
    }

    return allowed.some((pattern) => pattern.test(path))
      ? []
      : [{
        path,
        reason: 'Path is outside the evidenced task scope'
      }]
  })
}

async function regressionFilesUnchanged(workspace) {
  try {
    for (const path of trustedRegressionPaths) {
      const [trusted, candidate] = await Promise.all([
        readFile(resolve(trustedSource, path)),
        readFile(resolve(workspace, path))
      ])

      if (!trusted.equals(candidate)) {
        return false
      }
    }

    return true
  } catch {
    return false
  }
}

function parsePlaywrightContracts(detail) {
  const mapping = {
    availability: 'availability contract',
    'selected-context': 'selected order context contract',
    analytics: 'analytics contract',
    localization: 'localization contract',
    keyboard: 'keyboard contract'
  }

  return Object.fromEntries(Object.entries(mapping).map(([id, title]) => {
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const failure = new RegExp(`\\d+\\) \\[(?:chromium|webkit)\\] › [^\\n]+ › ${escapedTitle}`)

    return [id, detail.includes(title) && !failure.test(detail)]
  }))
}

async function candidateTestPaths(workspace, paths) {
  const tests = []

  for (const path of paths.filter((candidate) => candidate.endsWith('.test.ts'))) {
    try {
      const metadata = await lstat(resolve(workspace, path))

      if (metadata.isFile()) {
        tests.push(path)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error
      }
    }
  }

  return {
    browser: tests.filter((path) => requiredCandidateTests.browser.test(path)),
    unit: tests.filter((path) => requiredCandidateTests.unit.test(path))
  }
}

function assertUntrustedProcessCleanup(home) {
  const childSource = 'setInterval(() => {}, 60_000)'

  const probe = run(
    process.execPath,
    [
      '-e',
      `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { detached: true, stdio: 'ignore' }); child.unref(); console.log(child.pid)`
    ],
    {
      env: { HOME: home },
      untrusted: true
    }
  )

  const processId = Number(probe.stdout.trim())

  if (!probe.passed || !Number.isInteger(processId) || processIsActive(processId)) {
    throw new Error('Untrusted process cleanup control failed')
  }
}

async function writeHiddenHarness(temporaryRoot) {
  const hiddenDirectory = resolve(temporaryRoot, 'trusted-tests')
  const configPath = resolve(temporaryRoot, 'playwright.hidden.config.mjs')

  await symlink(runtimeModules, resolve(temporaryRoot, 'node_modules'), 'dir')
  await mkdir(hiddenDirectory)

  await cp(
    '/tests-hidden/order-receipt.hidden.test.ts',
    resolve(hiddenDirectory, 'order-receipt.hidden.test.ts')
  )

  await writeFile(
    configPath,
    `export default {\n  expect: { timeout: 2_000 },\n  forbidOnly: true,\n  fullyParallel: false,\n  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR,\n  reporter: 'line',\n  retries: 0,\n  testDir: ${JSON.stringify(hiddenDirectory)},\n  timeout: 10_000,\n  projects: [\n    { name: 'chromium', use: { browserName: 'chromium' } },\n    { name: 'webkit', use: { browserName: 'webkit' } }\n  ],\n  use: { actionTimeout: 2_000, baseURL: 'http://127.0.0.1:4173' },\n  webServer: {\n    command: 'node node_modules/vite/bin/vite.js preview --host 0.0.0.0 --port 4173',\n    cwd: process.env.PLAYWRIGHT_WORKSPACE,\n    port: 4173,\n    reuseExistingServer: false\n  }\n}\n`
  )

  await chmod(resolve(hiddenDirectory, 'order-receipt.hidden.test.ts'), 0o444)
  await chmod(hiddenDirectory, 0o555)
  await chmod(configPath, 0o444)

  return configPath
}

function runHiddenChecks(workspace, home, configPath, options = {}) {
  const args = [playwrightCli, 'test', `--config=${configPath}`]

  if (options.grep !== undefined) {
    args.push('--grep', options.grep)
  }

  return run(process.execPath, args, {
    cwd: workspace,

    env: {
      HOME: home,
      PLAYWRIGHT_OUTPUT_DIR: resolve(home, 'test-results'),
      PLAYWRIGHT_WORKSPACE: workspace,
      RECEIPT_LABEL: options.receiptLabel ?? 'View receipt'
    },

    untrusted: true
  })
}

async function replaceLocaleLabel(workspace, replacement) {
  const locales = resolve(workspace, 'src/locales')
  let replacements = 0

  for (const entry of await readdir(locales, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) {
      continue
    }

    const path = resolve(locales, entry.name)
    const source = await readFile(path, 'utf8')
    const updated = source.replaceAll('View receipt', replacement)

    if (updated !== source) {
      replacements += 1

      await writeFile(path, updated)
    }
  }

  return replacements > 0
}

async function scoreAndWriteOutputs(result) {
  await mkdir(verifierLogs, { recursive: true })

  const verifierResultSource = `${JSON.stringify(result, null, 2)}\n`
  const verifierResultDigest = sha256(verifierResultSource)

  await writeFile(resolve(verifierLogs, 'verifier-result.json'), verifierResultSource)

  if (!result.integrity.passed) {
    const invalidScore = {
      document_type: 'score',
      schema_version: 1,
      score_id: `order-receipt-${runId}`,
      run_id: runId,
      verifier_result_digest: verifierResultDigest,
      scoring_revision: 'order-receipt-scoring-v1',
      rubric_revision: 'order-receipt-rubric-v2',
      valid_grade: false,

      gates: {
        direct_behavior_pass: false,
        regression_pass: false,
        verifier_integrity_pass: false
      },

      facets: {
        direct_behavior: {
          status: 'unknown',
          reason: 'Verifier integrity failed',
          evidence: []
        },

        repository_contracts: {
          status: 'unknown',
          reason: 'Verifier integrity failed',
          evidence: []
        },

        regression: {
          status: 'unknown',
          reason: 'Verifier integrity failed',
          evidence: []
        },

        scope_integrity: {
          status: 'unknown',
          reason: 'Verifier integrity failed',
          evidence: []
        },

        maintainability: {
          status: 'not_applicable',
          reason: 'Maintainability is outside this rubric',
          evidence: []
        }
      },

      scope_violations: [],

      harbor_reward: {
        status: 'not_available',
        numeric_values: {}
      },

      composite: {
        status: 'unknown',
        reason: 'Verifier integrity failed'
      }
    }

    await writeFile(resolve(verifierLogs, 'score.json'), `${JSON.stringify(invalidScore, null, 2)}\n`)

    return false
  }

  const outcome = (passed) => (passed ? 'passed' : 'failed')

  const evidence = (id, passed) => ({
    check_id: id,
    outcome: outcome(passed),
    evidence_digest: sha256(JSON.stringify(result.checks[id]))
  })

  const direct = result.checks['direct-behavior'].passed
  const regression = result.checks.regression.passed
  const scope = result.checks.scope.passed

  const contractValue =
    contractIds.filter((id) => result.checks[id].passed).length / contractIds.length

  const gate = Number(direct && regression)
  const composite = gate * (0.45 * Number(direct) + 0.35 * contractValue + 0.2 * Number(scope))

  const reward = {
    direct_behavior: Number(direct),
    repository_contracts: contractValue,
    regression: Number(regression),
    scope_integrity: Number(scope)
  }

  const score = {
    document_type: 'score',
    schema_version: 1,
    score_id: `order-receipt-${runId}`,
    run_id: runId,
    verifier_result_digest: verifierResultDigest,
    scoring_revision: 'order-receipt-scoring-v1',
    rubric_revision: 'order-receipt-rubric-v2',
    valid_grade: true,

    gates: {
      direct_behavior_pass: direct,
      regression_pass: regression,
      verifier_integrity_pass: true
    },

    facets: {
      direct_behavior: {
        status: 'value',
        value: Number(direct),
        evidence: [evidence('direct-behavior', direct)]
      },

      repository_contracts: {
        status: 'value',
        value: contractValue,
        evidence: contractIds.map((id) => evidence(id, result.checks[id].passed))
      },

      regression: {
        status: 'value',
        value: Number(regression),
        evidence: [evidence('regression', regression)]
      },

      scope_integrity: {
        status: 'value',
        value: Number(scope),
        evidence: [evidence('scope', scope)]
      },

      maintainability: {
        status: 'not_applicable',
        reason: 'Maintainability is outside this rubric',
        evidence: []
      }
    },

    scope_violations: result.scopeViolations.map((violation) => ({
      ...violation,
      evidence_digest: sha256(JSON.stringify(violation))
    })),

    harbor_reward: {
      status: 'retained_upstream',
      numeric_values: reward
    },

    composite: {
      status: 'value',
      value: composite
    }
  }

  await writeFile(resolve(verifierLogs, 'score.json'), `${JSON.stringify(score, null, 2)}\n`)
  await writeFile(resolve(verifierLogs, 'reward.json'), `${JSON.stringify(reward, null, 2)}\n`)

  return true
}

async function verify() {
  const temporaryRoot = await mkdtemp('/tmp/order-receipt-verifier-')
  const workspace = resolve(temporaryRoot, 'candidate-workspace')
  const pristineUnitWorkspace = resolve(temporaryRoot, 'pristine-unit-workspace')
  const pristineBrowserWorkspace = resolve(temporaryRoot, 'pristine-browser-workspace')
  const localizationWorkspace = resolve(temporaryRoot, 'localization-workspace')
  const hiddenWorkspace = resolve(temporaryRoot, 'hidden-workspace')
  const candidateHome = resolve(temporaryRoot, 'candidate-home')
  const pristineUnitHome = resolve(temporaryRoot, 'pristine-unit-home')
  const pristineBrowserHome = resolve(temporaryRoot, 'pristine-browser-home')
  const localizationHome = resolve(temporaryRoot, 'localization-home')
  const hiddenHome = resolve(temporaryRoot, 'hidden-home')
  const processControlHome = resolve(temporaryRoot, 'process-control-home')

  try {
    await chmod(temporaryRoot, 0o755)
    await mkdir(processControlHome)
    await chownTree(processControlHome)
    assertUntrustedProcessCleanup(processControlHome)

    const conventionalArtifacts = await readdir('/logs/artifacts').catch(() => [])

    const credentialsAbsent = [
      'CODEX_ACCESS_TOKEN',
      'CODEX_AUTH_JSON_PATH',
      'OPENAI_API_KEY'
    ].every((name) => process.env[name] === undefined)

    const interfaces = Object.values(networkInterfaces()).flatMap((value) => value ?? [])
    const networkIsolated = interfaces.every(({ internal }) => internal)

    await verifyWorkspaceArtifacts({
      artifacts,
      destination: workspace,
      expectedBaseCommit: baseCommit,
      expectedSourceDigest: sourceDigest,
      source: trustedSource
    })

    const repository = await inspectMaterializedTaskWorkspace(workspace)

    const repositoryIntegrity =
      repository.commitCount === 1 &&
      repository.baseCommit === baseCommit &&
      repository.remotes.length === 0 &&
      repository.hooks.length === 0 &&
      repository.alternates.length === 0 &&
      repository.unreachable === ''

    const integrityPassed =
      conventionalArtifacts.length === 0 &&
      credentialsAbsent &&
      networkIsolated &&
      repositoryIntegrity

    if (!integrityPassed) {
      return {
        checks: {},

        integrity: {
          conventionalArtifacts,
          credentialsAbsent,
          interfaces,
          networkIsolated,
          passed: false,
          repository
        },

        scopeViolations: []
      }
    }

    const paths = stageAndListChangedPaths(workspace)
    const violations = scopeViolations(paths)
    const candidateTests = await candidateTestPaths(workspace, paths)
    const candidateTestShape = candidateTests.browser.length > 0 && candidateTests.unit.length > 0
    const regressionShape = await regressionFilesUnchanged(workspace)

    await prepareUntrustedWorkspace(workspace, candidateHome)
    await resetRuntimeCaches()

    const build = runBuild(workspace, candidateHome)

    const regressionUnit = run(
      process.execPath,
      [
        vitestCli,
        '--root',
        workspace,
        'run',
        'src/components/OrderCard.test.ts',
        'src/stores/orders.test.ts'
      ],
      {
        cwd: workspace,
        env: { HOME: candidateHome },
        untrusted: true
      }
    )

    const regressionBrowser = build.passed
      ? run(process.execPath, [playwrightCli, 'test', 'tests/e2e/order-details.test.ts'], {
        cwd: workspace,
        env: { HOME: candidateHome },
        untrusted: true
      })
      : {
        command: 'trusted browser regressions',
        detail: 'Skipped because build failed',
        passed: false,
        status: null
      }

    const regressionPassed =
      regressionShape && build.passed && regressionUnit.passed && regressionBrowser.passed

    const candidateUnit = candidateTestShape
      ? run(process.execPath, [vitestCli, '--root', workspace, 'run', ...candidateTests.unit], {
        cwd: workspace,
        env: { HOME: candidateHome },
        untrusted: true
      })
      : {
        command: 'candidate unit tests',
        detail: 'Candidate unit test missing',
        passed: false,
        status: null
      }

    const candidateBrowser = build.passed && candidateTests.browser.length > 0
      ? run(process.execPath, [playwrightCli, 'test', ...candidateTests.browser], {
        cwd: workspace,
        env: { HOME: candidateHome },
        untrusted: true
      })
      : {
        command: 'candidate browser tests',
        detail: 'Candidate browser test missing or build failed',
        passed: false,
        status: null
      }

    await materializeTaskWorkspace({
      destination: pristineUnitWorkspace,
      expectedSourceDigest: sourceDigest,
      source: trustedSource
    })

    await copyCandidateTests(workspace, pristineUnitWorkspace, candidateTests.unit)
    await prepareUntrustedWorkspace(pristineUnitWorkspace, pristineUnitHome)

    const pristineCandidateUnit = candidateTestShape
      ? run(
          process.execPath,
          [vitestCli, '--root', pristineUnitWorkspace, 'run', ...candidateTests.unit],
          {
            cwd: pristineUnitWorkspace,
            env: { HOME: pristineUnitHome },
            expectFailure: true,
            untrusted: true
          }
        )
      : {
        command: 'pristine candidate unit tests',
        detail: 'Candidate unit test missing',
        passed: false,
        status: null
      }

    await materializeTaskWorkspace({
      destination: pristineBrowserWorkspace,
      expectedSourceDigest: sourceDigest,
      source: trustedSource
    })

    await copyCandidateTests(workspace, pristineBrowserWorkspace, candidateTests.browser)
    await prepareUntrustedWorkspace(pristineBrowserWorkspace, pristineBrowserHome)
    await resetRuntimeCaches()

    const pristineBrowserBuild = candidateTestShape
      ? runBuild(pristineBrowserWorkspace, pristineBrowserHome)
      : {
        command: 'pristine candidate browser build',
        detail: 'Candidate browser test missing',
        passed: false,
        status: null
      }

    const pristineCandidateBrowser = pristineBrowserBuild.passed
      ? run(
          process.execPath,
          [playwrightCli, 'test', ...candidateTests.browser, '--project=chromium'],
          {
            cwd: pristineBrowserWorkspace,
            env: { HOME: pristineBrowserHome },
            expectFailure: true,
            untrusted: true
          }
        )
      : {
        command: 'pristine candidate browser tests',
        detail: 'Candidate browser test missing or pristine build failed',
        passed: false,
        status: null
      }

    const candidateTestsPassed =
      candidateTestShape &&
      build.passed &&
      candidateUnit.passed &&
      candidateBrowser.passed &&
      pristineCandidateUnit.passed &&
      pristineCandidateBrowser.passed

    await verifyWorkspaceArtifacts({
      artifacts,
      destination: localizationWorkspace,
      expectedBaseCommit: baseCommit,
      expectedSourceDigest: sourceDigest,
      source: trustedSource
    })

    const localizationProbeLabel = 'Receipt translation probe'

    const localeReplacement = await replaceLocaleLabel(
      localizationWorkspace,
      localizationProbeLabel
    )

    await prepareUntrustedWorkspace(localizationWorkspace, localizationHome)
    await resetRuntimeCaches()

    const localizationBuild = runBuild(localizationWorkspace, localizationHome)

    await verifyWorkspaceArtifacts({
      artifacts,
      destination: hiddenWorkspace,
      expectedBaseCommit: baseCommit,
      expectedSourceDigest: sourceDigest,
      source: trustedSource
    })

    await prepareUntrustedWorkspace(hiddenWorkspace, hiddenHome)
    await resetRuntimeCaches()

    const hiddenBuild = runBuild(hiddenWorkspace, hiddenHome)

    await lockTree(localizationWorkspace)
    await lockTree(hiddenWorkspace)

    const hiddenConfig = await writeHiddenHarness(temporaryRoot)

    const localizationProbe = localeReplacement && localizationBuild.passed
      ? runHiddenChecks(localizationWorkspace, localizationHome, hiddenConfig, {
          grep: 'localization contract',
          receiptLabel: localizationProbeLabel
        })
      : {
        command: 'localization mutation probe',
        detail: 'Locale label was not replaced or the mutation build failed',
        passed: false,
        status: null
      }

    const hidden = hiddenBuild.passed
      ? runHiddenChecks(hiddenWorkspace, hiddenHome, hiddenConfig)
      : {
        command: 'hidden Playwright checks',
        detail: 'Skipped because build failed',
        passed: false,
        status: null
      }

    const parsedContracts = parsePlaywrightContracts(hidden.detail)

    parsedContracts.localization =
      parsedContracts.localization &&
      localizationProbe.passed

    const directFailure = /\d+\) \[(?:chromium|webkit)\] › [^\n]+ › direct receipt behavior/.test(
      hidden.detail
    )

    const directBehavior = hidden.detail.includes('direct receipt behavior') && !directFailure

    return {
      checks: {
        analytics: {
          detail: hidden.detail,
          passed: parsedContracts.analytics
        },

        availability: {
          detail: hidden.detail,
          passed: parsedContracts.availability
        },

        'candidate-tests': {
          detail: JSON.stringify({
            build,
            candidateBrowser,
            candidateTests,
            candidateUnit,
            pristineBrowserBuild,
            pristineCandidateBrowser,
            pristineCandidateUnit
          }),

          passed: candidateTestsPassed
        },

        'direct-behavior': {
          detail: hidden.detail,
          passed: directBehavior
        },

        keyboard: {
          detail: hidden.detail,
          passed: parsedContracts.keyboard
        },

        localization: {
          detail: JSON.stringify({
            hidden,
            localizationBuild,
            localizationProbe
          }),

          passed: parsedContracts.localization
        },

        regression: {
          detail: JSON.stringify({
            build,
            regressionBrowser,
            regressionShape,
            regressionUnit
          }),

          passed: regressionPassed
        },

        scope: {
          detail: JSON.stringify(violations),
          passed: violations.length === 0
        },

        'selected-context': {
          detail: hidden.detail,
          passed: parsedContracts['selected-context']
        }
      },

      integrity: {
        conventionalArtifacts,
        credentialsAbsent,
        interfaces,
        networkIsolated,
        passed: true,
        repository
      },

      scopeViolations: violations
    }
  } finally {
    await rm(temporaryRoot, {
      force: true,
      recursive: true
    })
  }
}

let result

try {
  result = await verify()
} catch (error) {
  result = {
    checks: {},

    integrity: {
      error: error instanceof Error ? error.stack : String(error),
      passed: false
    },

    scopeViolations: []
  }
}

const complete = await scoreAndWriteOutputs(result)

if (!complete) {
  process.exitCode = 2
}
