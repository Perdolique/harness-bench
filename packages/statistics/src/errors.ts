export const STATISTICS_ERROR_CODES = [
  'INCOMPATIBLE_COMPARISON',
  'UNSUPPORTED_ANALYSIS_REVISION'
] as const

export type StatisticsErrorCode = (typeof STATISTICS_ERROR_CODES)[number]

export class StatisticsError extends Error {
  readonly code: StatisticsErrorCode

  constructor(code: StatisticsErrorCode, message: string, options: ErrorOptions = {}) {
    super(message, options)

    this.name = 'StatisticsError'
    this.code = code
  }
}

export function isStatisticsError(error: unknown): error is StatisticsError {
  return error instanceof StatisticsError
}
