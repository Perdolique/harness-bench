export const CLI_SYNOPSIS = `Usage:
  benchctl experiment plan DEFINITION --runs-dir ABSOLUTE_DIR [--dry-run]
  benchctl experiment run|resume|report|compare PLAN
  benchctl experiment rerun-block PLAN --block ID --revision REV
  benchctl experiment invalidate PLAN --block ID --cause CAUSE --reason TEXT
  benchctl run --experiment FILE --run-id ID --stack FILE --harness-document FILE --suite FILE --task FILE --task-source DIR --task-package DIR --harness-bundle DIR --runs-dir ABSOLUTE_DIR [--dry-run]
  benchctl harness capture --source DIR --store DIR --id ID --revision REV
  benchctl harness validate BUNDLE
  benchctl harness materialize BUNDLE --destination DIR
  benchctl harness diff LEFT RIGHT
  benchctl results normalize RUN_DIR
  benchctl results report NORMALIZED_RECORD
  benchctl results export NORMALIZED_RECORD
  benchctl results dispose RUN_DIR --confirm-run-id ID --reason retention-expired|owner-request|credential-detected --disposition delete|incident-retain [--credential-action rotated|revoked] [--incident-expires-at ISO_TIMESTAMP]
`

export class CliUsageError extends Error {}
