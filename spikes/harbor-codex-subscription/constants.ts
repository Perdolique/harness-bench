import { resolve } from 'node:path'

export const SPIKE_ROOT = resolve(import.meta.dirname)
export const REPOSITORY_ROOT = resolve(SPIKE_ROOT, '../..')

export const HARBOR_VERSION = '0.22.0'
export const CODEX_VERSION = '0.153.2'
export const MODEL = 'gpt-5.6-luna'
export const REASONING_EFFORT = 'medium'
export const PROTOCOL_REVISION = 'public-1'

export const NODE_IMAGE =
  'node:26.8.1-bookworm-slim@sha256:f105cb6a6b56d32ea0295fcd100e4f06afa29ac51396315497f37eb9dc2b2848'
export const GOST_IMAGE =
  'gogost/gost:3.2.7-nightly.20260602@sha256:b78c2c1c495117cc9d75be775e4b3a5737b64d72c97ed66e99866aaabb1d3cb6'

export const IMAGE_NAMES = {
  agent: `harness-bench-issue-2-agent:${CODEX_VERSION}-arm64`,
  collector: 'harness-bench-issue-2-collector:public-1-arm64',
  verifier: 'harness-bench-issue-2-verifier:public-1-arm64',
  egress: 'harbor-prebuilt:harbor-docker-egress-control-sidecar'
} as const

export const LIMITS = {
  agentTimeoutSeconds: 600,
  buildTimeoutSeconds: 900,
  collectorTimeoutSeconds: 60,
  cpuCount: 2,
  maximumBytes: 10 * 1024 * 1024,
  maximumPaths: 1_000,
  memoryMegabytes: 2_048,
  verifierTimeoutSeconds: 120
} as const

export const ALLOWED_CHANGED_PATHS = [
  'src/normalize-room-label.mjs',
  'test/regression.test.mjs'
] as const

export const EXPECTED_ARTIFACTS = [
  {
    destination: 'artifacts/logs/artifacts',
    source: '/logs/artifacts',
    service: null,
    status: 'empty',
    type: 'directory'
  },
  {
    destination: 'artifacts/trusted-collector',
    source: '/evidence',
    service: 'collector',
    status: 'ok',
    type: 'directory'
  }
] as const

export type SpikePhase = 'public'
