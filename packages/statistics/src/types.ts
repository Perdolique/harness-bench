export type QualityMetricName =
  | 'pass_rate'
  | 'direct_behavior'
  | 'repository_contracts'
  | 'regression'
  | 'scope_integrity'
  | 'maintainability'
  | 'composite'

export type OperationalMetricName =
  | 'total_seconds'
  | 'agent_seconds'
  | 'verifier_seconds'
  | 'input_tokens'
  | 'output_tokens'

export type ComparisonMetricName =
  | QualityMetricName
  | OperationalMetricName
  | 'end_to_end_reliability'

export interface DistributionSummaryV1 {
  readonly knownCount: number;
  readonly unknownCount: number;
  readonly mean: number | null;
  readonly minimum: number | null;
  readonly firstQuartile: number | null;
  readonly median: number | null;
  readonly thirdQuartile: number | null;
  readonly maximum: number | null;
}

export interface ConfidenceIntervalV1 {
  readonly lower: number;
  readonly upper: number;
}

export interface WinTieLossV1 {
  readonly wins: number;
  readonly ties: number;
  readonly losses: number;
}

export interface MetricComparisonV1 {
  readonly metric: ComparisonMetricName;
  readonly pairedObservations: number;
  readonly taskClusters: number;
  readonly leftDistribution: DistributionSummaryV1;
  readonly rightDistribution: DistributionSummaryV1;
  readonly meanDelta: number | null;
  readonly confidenceInterval: ConfidenceIntervalV1 | null;
  readonly winTieLoss: WinTieLossV1 | null;
}

export interface TaskMetricComparisonV1 {
  readonly metric: ComparisonMetricName;
  readonly pairedObservations: number;
  readonly leftMean: number;
  readonly rightMean: number;
  readonly delta: number;
}

export interface TaskReliabilityComparisonV1 {
  readonly left: boolean | null;
  readonly right: boolean | null;
  readonly delta: number | null;
}

export interface TaskPairComparisonV1 {
  readonly taskId: string;
  readonly eligibleReplicates: number;
  readonly requestedReplicates: number;
  readonly metrics: readonly TaskMetricComparisonV1[];
  readonly reliability: TaskReliabilityComparisonV1;
}

export interface ArmReferenceV1 {
  readonly armId: string;
  readonly treatment: string;
  readonly harnessId: string;
  readonly harnessRevision: string;
  readonly harnessDigest: string;
}

export interface OutcomeCountV1 {
  readonly outcome: string;
  readonly count: number;
}

export interface ObservedMetricV1 {
  readonly metric: OperationalMetricName;
  readonly distribution: DistributionSummaryV1;
}

export interface ArmObservedSummaryV1 {
  readonly arm: ArmReferenceV1;
  readonly attempts: number;
  readonly outcomes: readonly OutcomeCountV1[];
  readonly metrics: readonly ObservedMetricV1[];
}

export interface OmittedRunV1 {
  readonly armId: string;
  readonly runId: string;
  readonly status: string;
  readonly classification: string | null;
}

export interface OmittedBlockV1 {
  readonly predecessor: boolean;
  readonly blockId: string;
  readonly taskId: string;
  readonly replicate: number;
  readonly status: string;
  readonly cause: string | null;
  readonly reason: string;
  readonly runs: readonly OmittedRunV1[];
}

export interface ArmPairComparisonV1 {
  readonly leftArm: ArmReferenceV1;
  readonly rightArm: ArmReferenceV1;
  readonly eligibleBlocks: number;
  readonly totalBlocks: number;
  readonly tasks: readonly TaskPairComparisonV1[];
  readonly metrics: readonly MetricComparisonV1[];
}

export interface BootstrapMethodV1 {
  readonly seed: number;
  readonly resamples: 10_000;
  readonly confidence: 0.95;
  readonly intervalMethod: 'percentile_type_7';
  readonly cluster: 'task';
  readonly tieRule: 'exact_zero';
  readonly generator: 'mulberry32';
}

export interface ComparisonMigrationTargetV1 {
  readonly taskId: string;
  readonly sourceVerifierRevision: string;
  readonly sourceVerifierImageDigest: string;
  readonly sourceVerifierNetworkEnforcementSidecarDigest:
    VerifierNetworkEnforcementSidecarIdentityV1;
  readonly targetVerifierRevision: string;
  readonly targetVerifierImageDigest: string;
  readonly targetVerifierNetworkEnforcementSidecarDigest:
    VerifierNetworkEnforcementSidecarIdentityV1;
  readonly sourceScoringRevision: string;
  readonly targetScoringRevision: string;
  readonly sourceRubricRevision: string;
  readonly targetRubricRevision: string;
}

export type VerifierNetworkEnforcementSidecarIdentityV1 =
  | {
      readonly status: 'known';
      readonly value: string;
    }
  | {
      readonly status: 'not_applicable';
      readonly reason: string;
    }

export interface ComparisonMigrationV1 {
  readonly migrationId: string;
  readonly revision: string;
  readonly digest: string;
  readonly providerCalls: 0;
  readonly verifierSeconds: DistributionSummaryV1;
  readonly targets: readonly ComparisonMigrationTargetV1[];
}

export interface ExperimentComparisonAnalysisV1 {
  readonly experimentId: string;
  readonly experimentRevision: string;
  readonly planDigest: string;
  readonly suiteId: string;
  readonly suiteRevision: string;
  readonly analysisRevision: '1';
  readonly migration?: ComparisonMigrationV1 | null;
  readonly bootstrap: BootstrapMethodV1;
  readonly observed: readonly ArmObservedSummaryV1[];
  readonly omittedBlocks: readonly OmittedBlockV1[];
  readonly pairs: readonly ArmPairComparisonV1[];
  readonly limitations: readonly string[];
}
