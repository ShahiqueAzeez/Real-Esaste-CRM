import { HttpException, HttpStatus } from '@nestjs/common';

/** Application error with a stable machine-readable code. Rendered as { error: { code, message, details } }. */
export class AppError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export const Errors = {
  notFound: (what = 'Resource') => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found`),
  forbidden: (message = 'You do not have permission to do this') => new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', message),
  unauthorized: (message = 'Please sign in') => new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', message),
  conflict: (code: string, message: string, details?: unknown) => new AppError(HttpStatus.CONFLICT, code, message, details),
  badRequest: (code: string, message: string, details?: unknown) => new AppError(HttpStatus.BAD_REQUEST, code, message, details),
  validation: (details: unknown) => new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Some fields are invalid', details),
  precondition: (code: string, message: string, details?: unknown) => new AppError(HttpStatus.PRECONDITION_FAILED, code, message, details),
  unavailable: (code: string, message: string, details?: unknown) => new AppError(HttpStatus.SERVICE_UNAVAILABLE, code, message, details),
  featureUnavailable: (message: string) => new AppError(HttpStatus.NOT_IMPLEMENTED, 'FEATURE_UNAVAILABLE', message),
  paymentRequired: (message: string) => new AppError(HttpStatus.PAYMENT_REQUIRED, 'SUBSCRIPTION_INACTIVE', message),
  tooMany: (message: string) => new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', message),
};
