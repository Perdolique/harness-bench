import { lstat, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CREDENTIAL_PATTERN_SCANNER_REVISION, scanCredentialBytes } from '@harness-bench/core'
import type { ScoreDocument } from '@harness-bench/schemas'
import * as v from 'valibot'
import { ResultError } from './errors.ts'

import {
  NormalizedRunRecordV1Schema,
  SanitizedRunExportV1Schema,
  type NormalizedRunRecordV1,
  type SanitizedRunExportV1
} from './schemas.ts'

import {
  parseManagedRecordPath,
  readStoredRecord,
  serializeRecord,
  withRunResultLock,
  writeContentAddressedRecord
} from './storage.ts'

export interface ExportSanitizedResultOptions {
  readonly now?: Date;
}

export interface ExportSanitizedResultResult {
  readonly digest: string;
  readonly record: SanitizedRunExportV1;
  readonly recordPath: string;
}

async function hasRestriction(runsRoot: string, runId: string): Promise<boolean> {
  const restrictions = resolve(runsRoot, '.results', runId, 'restrictions')

  try {
    const metadata = await lstat(restrictions)

    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (metadata.mode & 0o777) !== 0o700
    ) {
      throw new ResultError(
        'EXPORT_BLOCKED',
        'Restriction state is not a valid managed directory',
        { stage: 'export' }
      )
    }

    return (await readdir(restrictions)).length > 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }

    throw error
  }
}

type SanitizedKnownScore = Extract<
  SanitizedRunExportV1['score'],
  { readonly status: 'known' }
>

type SanitizedFacet = SanitizedKnownScore['facets']['direct_behavior']

function sanitizedScore(
  score: NormalizedRunRecordV1['score']
): SanitizedRunExportV1['score'] {
  if (score.status === 'unavailable') {
    return { status: 'unavailable' }
  }

  const sanitize = (
    facet: ScoreDocument['facets']['direct_behavior']
  ): SanitizedFacet => {
    if (facet.status === 'value') {
      return {
        status: 'value',
        value: facet.value,
        evidence: facet.evidence
      }
    }

    return {
      status: facet.status,
      evidence: facet.evidence
    }
  }

  const document = score.document

  return {
    status: 'known',
    score_id: document.score_id,
    verifier_result_digest: document.verifier_result_digest,
    rubric_revision: document.rubric_revision,
    gates: document.gates,

    facets: {
      direct_behavior: sanitize(document.facets.direct_behavior),
      repository_contracts: sanitize(document.facets.repository_contracts),
      regression: sanitize(document.facets.regression),
      scope_integrity: sanitize(document.facets.scope_integrity),
      maintainability: sanitize(document.facets.maintainability)
    },

    scope_violation_evidence_digests: document.scope_violations.map(
      ({ evidence_digest: evidenceDigest }) => evidenceDigest
    ),

    harbor_reward: document.harbor_reward,

    composite: document.composite.status === 'value'
      ? document.composite
      : { status: document.composite.status }
  }
}

function sanitizedKnownInteger(
  value: NormalizedRunRecordV1['timings']['agent_seconds']
): SanitizedRunExportV1['timings']['agent_seconds'] {
  return value.status === 'known'
    ? value
    : { status: 'unknown' }
}

function sanitizedIdentities(
  identities: NormalizedRunRecordV1['identities']
): SanitizedRunExportV1['identities'] {
  const observedProviderIdentity =
    identities.agent.observed_provider_identity.status === 'known'
      ? {
          status: 'known' as const,
          value: identities.agent.observed_provider_identity.value
        }
      : { status: 'unknown' as const }

  return {
    benchmark_repo_commit: identities.benchmark_repo_commit,

    run: {
      run_id: identities.run.run_id,
      attempt_id: identities.run.attempt_id,
      attempt: identities.run.attempt
    },

    stack: {
      id: identities.stack.id,
      revision: identities.stack.revision,
      digest: identities.stack.digest
    },

    suite: {
      id: identities.suite.id,
      revision: identities.suite.revision,
      digest: identities.suite.digest
    },

    task: {
      id: identities.task.id,
      revision: identities.task.revision,
      base_commit: identities.task.base_commit,
      source_digest: identities.task.source_digest,
      environment_image_digest: identities.task.environment_image_digest
    },

    harness: {
      id: identities.harness.id,
      revision: identities.harness.revision,
      digest: identities.harness.digest
    },

    experiment: {
      experiment_id: identities.experiment.experiment_id,
      experiment_revision: identities.experiment.experiment_revision,
      plan_digest: identities.experiment.plan_digest,
      arm_id: identities.experiment.arm_id,
      block_id: identities.experiment.block_id,
      replicate: identities.experiment.replicate
    },

    agent: {
      product: identities.agent.product,
      cli_version: identities.agent.cli_version,
      requested_model: identities.agent.requested_model,
      observed_provider_identity: observedProviderIdentity,
      effort: identities.agent.effort,
      auth_mode: identities.agent.auth_mode
    },

    network_policy_digest: identities.network_policy_digest,
    effective_permissions_digest: identities.effective_permissions_digest,
    mcp_tools_digest: identities.mcp_tools_digest,

    host: {
      os: identities.host.os,
      os_version: identities.host.os_version,
      architecture: identities.host.architecture,
      apple_silicon_model: identities.host.apple_silicon_model,
      docker_desktop_version: identities.host.docker_desktop_version,
      docker_engine_version: identities.host.docker_engine_version,
      linuxkit_kernel: identities.host.linuxkit_kernel,
      container_architecture: identities.host.container_architecture
    }
  }
}

function sanitizedRevisions(
  revisions: NormalizedRunRecordV1['revisions']
): SanitizedRunExportV1['revisions'] {
  const sidecarDigest =
    revisions.verifier_network_enforcement_sidecar_digest.status === 'known'
      ? {
          status: 'known' as const,
          value: revisions.verifier_network_enforcement_sidecar_digest.value
        }
      : { status: 'not_applicable' as const }

  return {
    runner_name: revisions.runner_name,
    runner_version: revisions.runner_version,
    runner_config_digest: revisions.runner_config_digest,
    collector_revision: revisions.collector_revision,
    collector_image_digest: revisions.collector_image_digest,
    verifier_revision: revisions.verifier_revision,
    verifier_image_digest: revisions.verifier_image_digest,
    verifier_network_enforcement_sidecar_digest: sidecarDigest,
    scoring_revision: revisions.scoring_revision
  }
}

function sanitizedRetention(
  retention: NormalizedRunRecordV1['retention']
): SanitizedRunExportV1['retention'] {
  return retention.classification === 'private'
    ? retention
    : {
        classification: 'public',
        expires_at: { status: 'not_applicable' }
      }
}

function sanitizedUsage(
  usage: NormalizedRunRecordV1['usage']
): SanitizedRunExportV1['usage'] {
  return {
    input_tokens: sanitizedKnownInteger(usage.input_tokens),
    output_tokens: sanitizedKnownInteger(usage.output_tokens),
    subscription_money: { status: 'not_applicable' },

    upstream_api_price_estimate:
      usage.upstream_api_price_estimate.status === 'known'
        ? usage.upstream_api_price_estimate
        : { status: 'unknown' }
  }
}

function exportTimestamp(now: Date | undefined): string {
  const value = now ?? new Date()

  if (Number.isNaN(value.getTime())) {
    throw new ResultError('INVALID_INPUT', 'Export clock is invalid', {
      stage: 'export'
    })
  }

  return value.toISOString()
}

export async function exportSanitizedResult(
  normalizedRecordPath: string,
  options: ExportSanitizedResultOptions = {}
): Promise<ExportSanitizedResultResult> {
  const location = parseManagedRecordPath(normalizedRecordPath, 'normalized')

  return withRunResultLock(
    location.runsRoot,
    location.runId,
    async () => {
      const normalized = await readStoredRecord(
        normalizedRecordPath,
        'normalized',
        NormalizedRunRecordV1Schema
      )

      if (normalized.record.identities.run.run_id !== location.runId) {
        throw new ResultError(
          'EXPORT_BLOCKED',
          'Normalized record identity does not match its managed path',
          { stage: 'export' }
        )
      }

      const restricted = await hasRestriction(location.runsRoot, location.runId)

      if (restricted) {
        throw new ResultError(
          'EXPORT_BLOCKED',
          'This run is restricted and cannot be exported',
          { stage: 'export' }
        )
      }

      const candidate = {
        document_type: 'sanitized_run_export',
        schema_version: 1,
        normalization_revision: normalized.record.normalization_revision,
        record_type: 'sanitized_export',
        created_at: exportTimestamp(options.now),
        source_normalized_digest: normalized.digest,
        identities: sanitizedIdentities(normalized.record.identities),
        revisions: sanitizedRevisions(normalized.record.revisions),
        source_digests: normalized.record.source_digests,

        outcome: {
          classification: normalized.record.outcome.classification,
          valid_grade: normalized.record.outcome.valid_grade
        },

        score: sanitizedScore(normalized.record.score),

        timings: {
          total_seconds: normalized.record.timings.total_seconds,

          agent_seconds: sanitizedKnownInteger(
            normalized.record.timings.agent_seconds
          ),

          verifier_seconds: sanitizedKnownInteger(
            normalized.record.timings.verifier_seconds
          )
        },

        usage: sanitizedUsage(normalized.record.usage),
        retention: sanitizedRetention(normalized.record.retention),

        evidence: normalized.record.references.map((reference) => ({
          digest: reference.digest,
          size: reference.size,
          executable: reference.executable,
          format: reference.format,
          role: reference.role
        })),

        redaction_report: {
          scanner_revision: CREDENTIAL_PATTERN_SCANNER_REVISION,
          credential_findings: 0,
          content_bytes_included: false,
          local_paths_included: false,
          publication_authorized: false
        }
      }

      const parsed = v.safeParse(SanitizedRunExportV1Schema, candidate)

      if (!parsed.success) {
        throw new ResultError(
          'EXPORT_BLOCKED',
          'Normalized metadata does not satisfy the sanitized export allowlist',
          { stage: 'export' }
        )
      }

      const record = parsed.output
      const serialized = serializeRecord(record)
      const findings = scanCredentialBytes(serialized, { path: 'record.json' })

      if (findings.length > 0) {
        throw new ResultError(
          'EXPORT_BLOCKED',
          'Sanitized export failed the credential-pattern scan',
          { stage: 'export' }
        )
      }

      return writeContentAddressedRecord(
        location.runsRoot,
        location.runId,
        'exports',
        record
      )
    }
  )
}
