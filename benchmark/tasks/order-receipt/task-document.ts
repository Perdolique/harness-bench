import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { TaskDocumentSchema, type TaskDocument } from '../../../packages/schemas/src/index.ts'
import * as v from '../../../packages/schemas/node_modules/valibot/dist/index.mjs'

export interface OrderReceiptTaskDocumentInputs {
  readonly baseCommit: string;
  readonly collectorImageDigest: string;
  readonly environmentImageDigest: string;
  readonly sourceDigest: string;
  readonly verifierImageDigest: string;
}

function sha256(contents: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`
}

function contract(
  obligationId: string,
  expectation: string,
  evidencePaths: readonly string[],
  deterministicCheck: string
) {
  return {
    applicability: 'required' as const,
    deterministic_check: deterministicCheck,
    evidence_paths: evidencePaths,
    expectation,
    facet: 'repository_contracts' as const,
    justification: 'The pristine base demonstrates this repository-specific behavior before the requested action is added.',
    obligation_id: obligationId,
    weight: 1 / 6
  }
}

export async function buildOrderReceiptTaskDocument(
  inputs: OrderReceiptTaskDocumentInputs
): Promise<TaskDocument> {
  const taskRoot = import.meta.dirname
  const promptPath = resolve(taskRoot, 'instruction.md')
  const promptDigest = sha256(await readFile(promptPath))

  const candidate = {
    document_type: 'task',
    schema_version: 1,
    task_id: 'order-receipt',
    revision: 'order-receipt-task-v2',
    base_commit: inputs.baseCommit,
    source_digest: inputs.sourceDigest,

    environment: {
      digest: inputs.environmentImageDigest,
      id: 'order-receipt-playwright-arm64',
      revision: 'order-receipt-environment-v1'
    },

    collector: {
      image_digest: inputs.collectorImageDigest,
      revision: 'order-receipt-collector-v3'
    },

    verifier: {
      image_digest: inputs.verifierImageDigest,

      network_enforcement_sidecar_digest: {
        reason: 'Docker network_mode none is enforced by the verifier environment',
        status: 'not_applicable'
      },

      revision: 'order-receipt-verifier-v3'
    },

    scoring: {
      revision: 'order-receipt-scoring-v1',
      rubric_revision: 'order-receipt-rubric-v2'
    },

    prompt: {
      digest: promptDigest,
      path: 'instruction.md'
    },

    declared_artifacts: [
      {
      path: 'workspace.patch',
      required: true
    },
      {
      path: 'workspace-metadata.json',
      required: true
    }
    ],

    rubric: [
      {
        applicability: 'required',
        deterministic_check: 'verifier/order-receipt.hidden.test.ts#direct receipt behavior',
        evidence_paths: ['src/router.ts', 'src/pages/OrderReceiptPage.vue'],
        expectation: 'The action opens the existing receipt page for the activated order.',
        facet: 'direct_behavior',
        justification: 'The pristine route and receipt page define the requested destination.',
        obligation_id: 'direct-receipt',
        weight: 1
      },
      contract(
        'availability',
        'The action is shown only for available orders that have an access key.',
        ['src/components/OrderCard.vue', 'src/components/OrderCard.test.ts'],
        'verifier/order-receipt.hidden.test.ts#availability contract'
      ),
      contract(
        'selected-context',
        'The selected order is cleared during loading and a stale selection cannot replace the latest order.',
        ['src/stores/orders.ts', 'src/stores/orders.test.ts'],
        'verifier/order-receipt.hidden.test.ts#selected order context contract'
      ),
      contract(
        'analytics',
        'Activation emits exactly one public receipt action without the access key.',
        ['src/pages/OrderHistoryPage.vue', 'src/services/analytics.ts', 'tests/e2e/order-details.test.ts'],
        'verifier/order-receipt.hidden.test.ts#analytics contract'
      ),
      contract(
        'localization',
        'The action uses the English locale and the existing fallback mechanism.',
        [
          'src/components/OrderCard.test.ts',
          'src/i18n.ts',
          'src/locales/en.ts',
          'src/locales/de.ts'
        ],
        'verifier/order-receipt.hidden.test.ts#localization contract'
      ),
      contract(
        'keyboard',
        'The action is a semantic control that activates from the keyboard.',
        ['src/components/OrderCard.vue'],
        'verifier/order-receipt.hidden.test.ts#keyboard contract'
      ),
      contract(
        'candidate-tests',
        'Candidate unit and browser tests fail on the pristine behavior and pass on the implementation.',
        ['src/components/OrderCard.test.ts', 'tests/e2e/order-details.test.ts'],
        'verifier/container-verifier.mjs#candidate pristine transition control'
      ),
      {
        applicability: 'required',
        deterministic_check: 'verifier/container-verifier.mjs#trusted regressions',

        evidence_paths: [
          'src/components/OrderCard.test.ts',
          'src/stores/orders.test.ts',
          'tests/e2e/order-details.test.ts'
        ],

        expectation: 'Trusted pristine regressions remain unchanged and pass.',
        facet: 'regression',
        justification: 'These tests record supported behavior present before the task.',
        obligation_id: 'regression',
        weight: 1
      },
      {
        applicability: 'required',
        deterministic_check: 'verifier/container-verifier.mjs#scope envelope',
        evidence_paths: ['src/components/OrderCard.vue', 'src/pages/OrderHistoryPage.vue'],
        expectation: 'Changes stay within evidenced UI, navigation, localization, composable, and test paths.',
        facet: 'scope_integrity',
        justification: 'The pristine action flow identifies the files and extension points needed for this task.',
        obligation_id: 'scope',
        weight: 1
      }
    ],

    scope: {
      allowed: ['src/components', 'src/pages/OrderHistoryPage.vue'],
      conditional: ['src/composables', 'src/locales/en.ts', 'src/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
      forbidden: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'build configuration', 'existing regression tests']
    },

    online_reachability: {
      reason: 'The checked-in synthetic fixture and calibration material are publicly reachable.',
      status: 'ineligible'
    },

    retention: {
      classification: 'public',

      expires_at: {
        reason: 'The synthetic fixture contains no private source or secret material.',
        status: 'not_applicable'
      }
    }
  }

  return v.parse(TaskDocumentSchema, candidate)
}
