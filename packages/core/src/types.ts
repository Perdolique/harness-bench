import type { HarnessDocument } from '@harness-bench/schemas'

export type HarnessEntry = HarnessDocument['entries'][number]
export type HarnessEntryKind = HarnessEntry['kind']

export interface CaptureHarnessBundleOptions {
  readonly harnessId: string;
  readonly revision: string;
  readonly source: string;
  readonly store: string;
}

export interface CaptureHarnessBundleResult {
  readonly bundlePath: string;
  readonly manifest: HarnessDocument;
}

export interface ValidateHarnessBundleResult {
  readonly bundlePath: string;
  readonly manifest: HarnessDocument;
}

export interface MaterializeHarnessBundleOptions {
  readonly bundle: string;
  readonly destination: string;
}

export interface MaterializeHarnessBundleResult {
  readonly bundleDigest: string;
  readonly codexHome: string;
  readonly home: string;
  readonly mcpToolsPath: string;
  readonly root: string;
  readonly workspace: string;
}

export interface HarnessIdentityDifference {
  readonly field: 'harness_id' | 'revision';
  readonly left: string;
  readonly right: string;
}

export interface HarnessEntryAddition {
  readonly kind: 'added';
  readonly entry: HarnessEntry;
}

export interface HarnessEntryRemoval {
  readonly kind: 'removed';
  readonly entry: HarnessEntry;
}

export interface HarnessEntryModification {
  readonly kind: 'modified';
  readonly path: string;
  readonly left: HarnessEntry;
  readonly right: HarnessEntry;
}

export type HarnessEntryDifference =
  | HarnessEntryAddition
  | HarnessEntryRemoval
  | HarnessEntryModification

export interface HarnessBundleDiff {
  readonly different: boolean;
  readonly entryDifferences: readonly HarnessEntryDifference[];
  readonly identityDifferences: readonly HarnessIdentityDifference[];
  readonly left: HarnessDocument;
  readonly right: HarnessDocument;
}
