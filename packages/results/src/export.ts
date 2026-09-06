import { lstat, readdir } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
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

import { readStoredRecord, serializeRecord, writeContentAddressedRecord } from './storage.ts'

export interface ExportSanitizedResultOptions {
  readonly now?: Date;
}

export interface ExportSanitizedResultResult {
  readonly digest: string;
  readonly record: SanitizedRunExportV1;
  readonly recordPath: string;
}

function managedLocation(recordPath: string): {
  readonly runId: string;
  readonly runsRoot: string;
} {
  const absolutePath = resolve(recordPath)
  const addressRoot = dirname(absolutePath)
  const categoryRoot = dirname(addressRoot)
  const runRoot = dirname(categoryRoot)
  const resultsRoot = dirname(runRoot)

  if (
    basename(absolutePath) !== 'record.json' ||
    basename(categoryRoot) !== 'normalized' ||
    basename(resultsRoot) !== '.results'
  ) {
    throw new ResultError(
      'INVALID_INPUT',
      'Normalized record is outside the managed results layout',
      { stage: 'export' }
    )
  }

  return {
    runId: basename(runRoot),
    runsRoot: dirname(resultsRoot)
  }
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
  return {
    ...identities,

    agent: {
      ...identities.agent,

      observed_provider_identity:
        identities.agent.observed_provider_identity.status === 'known'
          ? identities.agent.observed_provider_identity
          : { status: 'unknown' }
    }
  }
}

function sanitizedRevisions(
  revisions: NormalizedRunRecordV1['revisions']
): SanitizedRunExportV1['revisions'] {
  return {
    ...revisions,

    verifier_network_enforcement_sidecar_digest:
      revisions.verifier_network_enforcement_sidecar_digest.status === 'known'
        ? revisions.verifier_network_enforcement_sidecar_digest
        : { status: 'not_applicable' }
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
  const location = managedLocation(normalizedRecordPath)

  const normalized = await readStoredRecord(
    normalizedRecordPath,
    'normalized',
    NormalizedRunRecordV1Schema
  )

  if (
    normalized.record.identities.run.run_id !== location.runId ||
    await hasRestriction(location.runsRoot, location.runId)
  ) {
    throw new ResultError(
      'EXPORT_BLOCKED',
      'This run is restricted and cannot be exported',
      { stage: 'export' }
    )
  }

  const record = v.parse(SanitizedRunExportV1Schema, {
    document_type: 'sanitized_run_export',
    schema_version: 1,
    normalization_revision: '1',
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
  })

  const findings = scanCredentialBytes(serializeRecord(record), {
    path: 'record.json'
  })

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
