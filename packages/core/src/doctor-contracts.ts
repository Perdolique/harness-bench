import * as v from 'valibot'

const text = v.pipe(v.string(), v.minLength(1))
const id = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,63}$/))

const controlSchema = v.strictObject({
  id,
  kind: v.picklist(['pristine', 'reference', 'alternate', 'test_deletion', 'test_disablement', 'forbidden_edit', 'negative']),
  solution: v.optional(text),
  expected_checks: v.record(id, v.boolean())
})

export const DoctorDefinitionSchema = v.pipe(
  v.strictObject({
    document_type: v.literal('doctor_definition'),
    schema_version: v.literal(1),
    revision: text,
    task_document: text,
    task_source: text,
    task_package: text,
    harness_bundle: text,
    forbidden_agent_paths: v.pipe(v.array(text), v.minLength(1)),
    controls: v.pipe(v.array(controlSchema), v.minLength(6))
  }),
  v.check((definition) => {
    const ids = definition.controls.map((control) => control.id)

    if (new Set(ids).size !== ids.length || ids.includes('reference-repeat')) return false

    const required = ['pristine', 'reference', 'alternate', 'test_deletion', 'test_disablement', 'forbidden_edit']

    for (const kind of required) {
      if (definition.controls.filter((control) => control.kind === kind).length !== 1) return false
    }

    return definition.controls.every((control) => {
      const expected = Object.values(control.expected_checks)

      if (expected.length === 0) return false

      if (control.kind === 'pristine') return control.solution === undefined && expected.includes(false)

      if (control.solution === undefined) return false

      if (control.kind === 'reference' || control.kind === 'alternate') return expected.every(Boolean)

      return expected.includes(false)
    })
  }, 'Doctor requires pristine, reference, alternate, deletion, disablement and forbidden-edit controls with explicit expectations')
)

export type DoctorDefinition = v.InferOutput<typeof DoctorDefinitionSchema>
export type DoctorControl = DoctorDefinition['controls'][number]
export type DoctorPurpose = 'smoke' | 'quality'
export type DoctorCheckStatus = 'passed' | 'failed' | 'warning' | 'not_run'

export type DoctorStage = 'input' | 'setup' | 'harbor' | 'collection' | 'verification' | 'finalization'

export interface DoctorCheck {
  readonly stage: DoctorStage;
  readonly failure_code: string | null;
  readonly code: string;
  readonly status: DoctorCheckStatus;
  readonly message: string;
  readonly action: string;
  readonly evidence: readonly string[];
}

export interface DoctorReport {
  readonly document_type: 'doctor_report';
  readonly schema_version: 1;
  readonly doctor_revision: 'doctor-v1';
  readonly purpose: DoctorPurpose;
  readonly allowed_use: 'none' | 'smoke' | 'quality';
  readonly exit_code: 0 | 1 | 2;
  readonly started_at: string;
  readonly completed_at: string;
  readonly input_digests: Readonly<Record<string, string>>;
  readonly checks: readonly DoctorCheck[];
  readonly evidence_manifest_digest: string;
  readonly limitations: readonly string[];
}

export interface DoctorOptions {
  readonly definition: string;
  readonly outputDirectory: string;
  readonly purpose?: DoctorPurpose;
}

export class DoctorError extends Error {
  readonly code: string
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)

    this.code = code
  }
}
