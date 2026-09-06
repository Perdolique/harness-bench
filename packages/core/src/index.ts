export {
  captureHarnessBundle,
  diffHarnessBundles,
  materializeHarnessBundle,
  validateHarnessBundle
} from './harness.ts'
export {
  HARNESS_ERROR_CODES,
  HarnessError,
  isHarnessError,
  type HarnessErrorCode,
  type HarnessErrorOptions
} from './errors.ts'
export {
  RUN_ERROR_CODES,
  RunError,
  isRunError,
  type RunErrorCode,
  type RunErrorOptions
} from './run-errors.ts'
export {
  resolveRunPlan,
  type ResolvedRunPlan,
  type ResolveRunPlanOptions,
  type RunExecutionResult
} from './run.ts'
export { executeRunPlan } from './run-execution.ts'
export {
  CREDENTIAL_PATTERN_CATEGORIES,
  CREDENTIAL_PATTERN_SCANNER_REVISION,
  scanCredentialBytes,
  scanCredentialTree,
  type CredentialPatternCategory,
  type CredentialPatternFinding,
  type CredentialTreeScanResult,
  type ScanCredentialBytesOptions,
  type ScanCredentialTreeOptions
} from './secret-scan.ts'
export {
  inspectMaterializedTaskWorkspace,
  inspectTaskSource,
  materializeTaskWorkspace
} from './task.ts'
export {
  captureWorkspaceArtifacts,
  verifyWorkspaceArtifacts
} from './task-artifacts.ts'
export type {
  CaptureHarnessBundleOptions,
  CaptureHarnessBundleResult,
  HarnessBundleDiff,
  HarnessEntry,
  HarnessEntryAddition,
  HarnessEntryDifference,
  HarnessEntryKind,
  HarnessEntryModification,
  HarnessEntryRemoval,
  HarnessIdentityDifference,
  MaterializeHarnessBundleOptions,
  MaterializeHarnessBundleResult,
  ValidateHarnessBundleResult
} from './types.ts'
export type {
  MaterializeTaskWorkspaceOptions,
  MaterializeTaskWorkspaceResult,
  TaskSourceSnapshot,
  TaskTreeEntry
} from './task.ts'
export type {
  CaptureWorkspaceArtifactsOptions,
  VerifyWorkspaceArtifactsOptions,
  WorkspaceArtifactMetadata
} from './task-artifacts.ts'
