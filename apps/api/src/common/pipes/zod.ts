import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import { z, type ZodType } from 'zod';
import { Errors } from '../errors';

function formatIssues(error: z.ZodError) {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code }));
}

export function parseOrThrow<T extends ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw Errors.validation(formatIssues(result.error));
  return result.data;
}

function jsonSchema(schema: ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  } catch {
    return { type: 'object' };
  }
}

/**
 * Validates the request body with a Zod schema and documents it in OpenAPI.
 * Usage: create(@ZBody(leadCreateSchema) body: z.output<typeof leadCreateSchema>)
 */
export function ZBody<T extends ZodType>(schema: T): ParameterDecorator {
  const param = createParamDecorator((_d: unknown, ctx: ExecutionContext) => parseOrThrow(schema, ctx.switchToHttp().getRequest().body ?? {}))();
  return (target, key, index) => {
    param(target, key, index);
    if (key !== undefined) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor) ApiBody({ schema: jsonSchema(schema) as never })(target, key, descriptor);
    }
  };
}

/** Validates query parameters with a Zod object schema and documents each property. */
export function ZQuery<T extends ZodType>(schema: T): ParameterDecorator {
  const param = createParamDecorator((_d: unknown, ctx: ExecutionContext) => parseOrThrow(schema, ctx.switchToHttp().getRequest().query ?? {}))();
  return (target, key, index) => {
    param(target, key, index);
    if (key !== undefined) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      const props = (jsonSchema(schema).properties ?? {}) as Record<string, Record<string, unknown>>;
      if (descriptor) {
        for (const [name, prop] of Object.entries(props)) ApiQuery({ name, required: false, schema: prop as never })(target, key, descriptor);
      }
    }
  };
}

/** Validates a UUID path parameter. */
export const UuidParam = (name: string) =>
  createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
    const value = ctx.switchToHttp().getRequest().params?.[name];
    const result = z.uuid().safeParse(value);
    if (!result.success) throw Errors.notFound();
    return result.data;
  })();
