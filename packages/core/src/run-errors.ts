export const RUN_ERROR_CODES = [
  'AUTH_REQUIRED',
  'DESTINATION_EXISTS',
  'EXECUTION_FAILED',
  'HOST_UNSUPPORTED',
  'INPUT_CHANGED',
  'INVALID_DOCUMENT',
  'INVALID_EVIDENCE',
  'INVALID_HARNESS',
  'INVALID_TASK_PACKAGE',
  'PIN_MISMATCH',
  'RELATIONSHIP_MISMATCH',
  'UNSUPPORTED_CONTROL'
] as const

export type RunErrorCode = (typeof RUN_ERROR_CODES)[number]

export interface RunErrorOptions extends ErrorOptions {
  readonly stage?: string;
}

export class RunError extends Error {
  readonly code: RunErrorCode
  readonly stage: string | undefined

  constructor(
    code: RunErrorCode,
    message: string,
    options: RunErrorOptions = {}
  ) {
    super(message, options)

    this.name = 'RunError'
    this.code = code
    this.stage = options.stage
  }
}

export function isRunError(error: unknown): error is RunError {
  return error instanceof RunError
}
