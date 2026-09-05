import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { makeJobConfig, materializeTask } from '../run-inputs.ts'

it('passes the owner-selected low effort to Harbor without changing the base harness', () => {
  const job = makeJobConfig(
    '/run',
    '/dataset',
    '/auth.json',
    'public-02',
    'low'
  )

  expect(job).toMatchObject({
    agents: [
      {
        name: 'codex',
        model_name: 'gpt-5.6-luna',
        kwargs: { reasoning_effort: 'low' }
      }
    ],

    n_attempts: 1,
    retry: { max_retries: 0 }
  })
})

it('materializes public agent networking and an offline verifier without an observer or solution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-bench-public-task-'))

  try {
    const dataset = await materializeTask(root)
    const task = join(dataset, 'normalize-room-label')
    const config = await readFile(join(task, 'task.toml'), 'utf8')

    expect(config).toMatch(/\[agent\][\s\S]*?network_mode = "public"/)
    expect(config).toMatch(/\[environment\][\s\S]*?network_mode = "public"/)
    expect(config).not.toMatch(/allowlist|allowed_hosts/)
    expect(config).toMatch(/\[verifier\][\s\S]*?environment_mode = "separate"/)

    const compose = await readFile(
      join(task, 'environment/docker-compose.yaml'),
      'utf8'
    )

    expect(compose).not.toMatch(
      /observer|NET_RAW|NET_ADMIN|SPIKE_PHASE|network_mode: service/
    )

    expect(compose).toMatch(/collector:[\s\S]*?network_mode: none/)

    expect(
      await readFile(join(task, 'tests/docker-compose.yaml'), 'utf8')
    ).toBe('services:\n  main:\n    network_mode: none\n')

    await expect(access(join(task, 'solution'))).rejects.toThrow()
    await expect(access(join(task, 'tests/hidden.test.mjs'))).rejects.toThrow()
  } finally {
    await rm(root, {
      recursive: true,
      force: true
    })
  }
})
