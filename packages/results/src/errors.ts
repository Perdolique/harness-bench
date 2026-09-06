export const RESULT_ERROR_CODES = [
  'INVALID_INPUT',
  'SOURCE_NOT_SEALED',
  'INTEGRITY_MISMATCH',
  'INCOMPATIBLE_VERSION',
  'INCOMPATIBLE_EVIDENCE',
  'RECORD_CONFLICT',
  'EXPORT_BLOCKED',
  'LIFECYCLE_REJECTED',
  'DISPOSITION_FAILED'
] as const

export type ResultErrorCode = (typeof RESULT_ERROR_CODES)[number]

export interface ResultErrorOptions extends ErrorOptions {
  readonly stage?: 'input' | 'normalization' | 'export' | 'disposition';
}

export class ResultError extends Error {
  readonly code: ResultErrorCode
  readonly stage: NonNullable<ResultErrorOptions['stage']>

  constructor(
    code: ResultErrorCode,
    message: string,
    options: ResultErrorOptions = {}
  ) {
    super(message, options)

    this.name = 'ResultError'
    this.code = code
    this.stage = options.stage ?? 'input'
  }
}

export function isResultError(error: unknown): error is ResultError {
  return error instanceof ResultError
}
