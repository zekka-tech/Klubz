import type { Context } from 'hono';
import type { AppEnv } from '../types';

const REQUEST_ID_HEADER = 'X-Request-ID';

export function getRequestIdFromContext(c: Context<AppEnv>): string | undefined {
  const contextRequestId = c.get('requestId');
  if (typeof contextRequestId === 'string' && contextRequestId.trim().length > 0) {
    return contextRequestId;
  }

  const headerRequestId = c.req.header(REQUEST_ID_HEADER)?.trim();
  if (headerRequestId && headerRequestId.length > 0) {
    return headerRequestId;
  }

  return undefined;
}

export function withRequestContext(
  c: Context<AppEnv>,
  meta?: Record<string, unknown>,
): Record<string, unknown> {
  const requestId = getRequestIdFromContext(c);
  return {
    ...(meta ?? {}),
    ...(requestId ? { requestId } : {}),
  };
}
