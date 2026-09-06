import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const fixture = resolve(repositoryRoot, 'fixtures/order-receipt')

const solution = resolve(
  repositoryRoot,
  'benchmark/tasks/order-receipt/solutions/reference/files'
)

const mutator = resolve(
  repositoryRoot,
  'benchmark/tasks/order-receipt/calibration/mutate.mjs'
)

const manifestPath = resolve(
  repositoryRoot,
  'benchmark/tasks/order-receipt/calibration/negative-controls.json'
)

const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Readonly<
  Record<string, readonly string[]>
>

const controls = Object.keys(manifest)

describe('canonical task negative controls', () => {
  test.each(controls)('applies %s to the formatted reference solution', async (control) => {
    const workspace = await mkdtemp('/tmp/harness-bench-negative-control-')

    try {
      await cp(fixture, workspace, {
        filter: (source) => {
          const path = relative(fixture, source)

          return !['dist', 'node_modules', 'test-results'].some(
            (entry) => path === entry || path.startsWith(`${entry}/`)
          )
        },

        recursive: true
      })

      await cp(solution, workspace, { recursive: true })

      const result = spawnSync(process.execPath, [mutator, control], {
        encoding: 'utf8',

        env: {
          ...process.env,
          CALIBRATION_WORKSPACE: workspace
        }
      })

      expect(result.status, result.stderr).toBe(0)
    } finally {
      await rm(workspace, {
        force: true,
        recursive: true
      })
    }
  })
})
