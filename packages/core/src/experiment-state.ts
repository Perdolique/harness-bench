import type { ExperimentAssignment, ExperimentPlan, InvalidationCause } from './experiment-contracts.ts'
import type { ResolvedRunPlan } from './run.ts'

export interface VerifiedExperimentRun {
  readonly classification: string;
  readonly valid_grade: boolean;
  readonly completed_at: string;
  readonly normalized_digest: string;
  readonly normalized_path: string;
  readonly observed_provider: string | null;
}
export interface ExperimentRunState {
  readonly assignment: ExperimentAssignment;
  readonly status: 'pending' | 'interrupted' | 'verified';
  readonly started_at: string | null;
  readonly result: VerifiedExperimentRun | null;
}
export interface ExperimentBlockState {
  readonly block_id: string;
  readonly first_started_at: string | null;
  readonly deadline_at: string | null;
  readonly completed_at: string | null;
  readonly status: 'planned' | 'in_progress' | 'completed' | 'invalidated';
  readonly cause: InvalidationCause | null;
  readonly reason: string | null;
  readonly runs: readonly ExperimentRunState[];
}
export interface ExperimentState {
  readonly plan: ExperimentPlan;
  readonly blocks: readonly ExperimentBlockState[];
  readonly superseded: boolean;
}
export interface ExperimentRuntime {
  readonly now: () => Date;
  readonly readState: (plan: ExperimentPlan, recover: boolean) => Promise<ExperimentState>;
  readonly execute: (plan: ResolvedRunPlan) => Promise<unknown>;
}
