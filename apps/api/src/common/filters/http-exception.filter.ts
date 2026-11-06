import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { TenantScopeViolation } from '../../infra/prisma/tenant-guard';

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

/** Renders every error as { error: { code, message, details, requestId } } without leaking internals. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    if (!res || typeof res.status !== 'function') return; // non-HTTP context (WebSocket handled separately)
    const requestId = typeof req?.id === 'string' ? req.id : undefined;
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: ErrorBody = { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' };

    if (exception instanceof ThrottlerException) {
      status = HttpStatus.TOO_MANY_REQUESTS;
      body = { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'object' && response && 'code' in response) {
        body = response as ErrorBody;
      } else {
        const message = typeof response === 'string' ? response : ((response as { message?: string | string[] })?.message ?? exception.message);
        body = { code: HttpStatus[status] ?? 'ERROR', message: Array.isArray(message) ? message.join('; ') : String(message) };
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        body = { code: 'DUPLICATE', message: 'A record with these details already exists' };
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        body = { code: 'NOT_FOUND', message: 'Resource not found' };
      } else {
        this.logger.error(`Prisma error ${exception.code}: ${exception.message}`);
      }
    } else if (exception instanceof TenantScopeViolation) {
      this.logger.error(exception.message, exception.stack);
    } else {
      const err = exception as Error;
      this.logger.error(`Unhandled error: ${err?.message}`, err?.stack);
    }

    if (status >= 500 && exception instanceof HttpException === false) {
      // keep generic message for unexpected errors
    }
    res.status(status).json({ error: { ...body, requestId } });
  }
}
