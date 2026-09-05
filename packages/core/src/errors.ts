export const HARNESS_ERROR_CODES = [
  'INVALID_SOURCE',
  'FORBIDDEN_PATH',
  'SECRET_DETECTED',
  'INVALID_CONFIG',
  'SOURCE_CHANGED',
  'INVALID_BUNDLE',
  'DESTINATION_EXISTS',
  'CODEX_VALIDATION_FAILED'
] as const

export type HarnessErrorCode = (typeof HARNESS_ERROR_CODES)[number]

export interface HarnessErrorOptions {
  readonly cause?: unknown;
  readonly path?: string;
}

export class HarnessError extends Error {
  readonly code: HarnessErrorCode
  readonly path?: string

  constructor(
    code: HarnessErrorCode,
    message: string,
    options: HarnessErrorOptions = {}
  ) {
    super(message, { cause: options.cause })

    this.name = 'HarnessError'
    this.code = code

    if (options.path !== undefined) {
      this.path = options.path
    }
  }
}

export function isHarnessError(error: unknown): error is HarnessError {
  return error instanceof HarnessError
}
