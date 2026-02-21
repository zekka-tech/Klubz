import { Hono } from 'hono'
import { createMatchingRoutes } from './routes/matching'
import { authRoutes } from './routes/auth'
import { userRoutes } from './routes/users'
import { tripRoutes } from './routes/trips'
import { adminRoutes } from './routes/admin'
import { monitoringRoutes } from './routes/monitoring'
import { paymentRoutes } from './routes/payments'
import { notificationRoutes } from './routes/notifications'
import { eventBus, isEventVisibleToUser } from './lib/eventBus'
import { logger } from './lib/logger'
import { getAnonymizedIP } from './lib/http'
import { AppError } from './lib/errors'
import { authMiddleware } from './middleware/auth'
import { rateLimiter } from './middleware/rateLimiter'
import type { Context } from 'hono'
import type { AppEnv, AuthUser } from './types'
type AppJsonInit = Parameters<Context<AppEnv>['json']>[1]

const app = new Hono<AppEnv>()

const REQUEST_ID_HEADER = 'X-Request-ID';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://klubz-production.pages.dev',
  'https://klubz-staging.pages.dev',
]);

const CORS_ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const CORS_ALLOWED_HEADERS = 'Content-Type, Authorization, X-Request-ID, X-CSRF-Token, Idempotency-Key';
const CORS_EXPOSED_HEADERS = 'X-Request-ID, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After';

function normalizeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function buildAllowedOrigins(c: Context<AppEnv>): Set<string> {
  const origins = new Set(DEFAULT_ALLOWED_ORIGINS);
  const appOrigin = normalizeOrigin(c.env?.APP_URL);
  if (appOrigin) origins.add(appOrigin);
  if (c.env?.ENVIRONMENT !== 'production') {
    origins.add('http://localhost:3000');
    origins.add('http://localhost:3001');
  }
  return origins;
}

function applyCorsBaseHeaders(c: Context<AppEnv>): void {
  c.header('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS);
  c.header('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
  c.header('Access-Control-Max-Age', '86400');
}

function applyCorsHeaders(c: Context<AppEnv>, origin: string): void {
  c.header('Access-Control-Allow-Origin', origin);
  c.header('Access-Control-Allow-Credentials', 'true');
  c.header('Access-Control-Expose-Headers', CORS_EXPOSED_HEADERS);
  c.header('Vary', 'Origin');
  applyCorsBaseHeaders(c);
}

function buildConnectSources(c: Context<AppEnv>): string[] {
  const sources = new Set<string>(["'self'", 'https://api.klubz.com']);
  const appOrigin = normalizeOrigin(c.env?.APP_URL);
  if (appOrigin) {
    sources.add(appOrigin);
    if (appOrigin.startsWith('https://')) {
      sources.add(appOrigin.replace('https://', 'wss://'));
    } else if (appOrigin.startsWith('http://')) {
      sources.add(appOrigin.replace('http://', 'ws://'));
    }
  }
  if (c.env?.ENVIRONMENT !== 'production') {
    sources.add('http://localhost:3000');
    sources.add('http://localhost:3001');
    sources.add('ws://localhost:3000');
    sources.add('ws://localhost:3001');
  }
  return [...sources];
}

function buildCspHeader(c: Context<AppEnv>, nonce: string): string {
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    "media-src 'self'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com",
    `script-src 'self' 'unsafe-hashes' 'nonce-${nonce}' https://cdn.tailwindcss.com https://unpkg.com https://cdn.jsdelivr.net`,
    // Inline style attributes are used in server-rendered shell HTML.
    "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://fonts.googleapis.com https://cdn.jsdelivr.net",
    `connect-src ${buildConnectSources(c).join(' ')}`,
  ];

  if (c.env?.ENVIRONMENT === 'production') {
    directives.push('upgrade-insecure-requests');
  }

  return directives.join('; ');
}

function getRuntimeConfigurationIssues(c: Context<AppEnv>): string[] {
  if (c.env?.ENVIRONMENT !== 'production') return [];

  const issues: string[] = [];
  const jwtSecret = c.env?.JWT_SECRET;
  const encryptionKey = c.env?.ENCRYPTION_KEY;
  const appUrl = c.env?.APP_URL;

  if (!jwtSecret) {
    issues.push('JWT_SECRET is required');
  } else if (jwtSecret.length < 32) {
    issues.push('JWT_SECRET must be at least 32 characters in production');
  }

  if (!encryptionKey) {
    issues.push('ENCRYPTION_KEY is required');
  } else if (!/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    issues.push('ENCRYPTION_KEY must be a 64-character hex string in production');
  }

  if (!normalizeOrigin(appUrl || undefined)) {
    issues.push('APP_URL must be a valid absolute URL in production');
  }

  return issues;
}

function getRequestId(c: Context<AppEnv>): string {
  const contextRequestId = c.get('requestId');
  if (typeof contextRequestId === 'string' && REQUEST_ID_PATTERN.test(contextRequestId)) {
    return contextRequestId;
  }

  const incomingRequestId = c.req.header(REQUEST_ID_HEADER)?.trim();
  const requestId = incomingRequestId && REQUEST_ID_PATTERN.test(incomingRequestId)
    ? incomingRequestId
    : crypto.randomUUID();

  c.set('requestId', requestId);
  c.header(REQUEST_ID_HEADER, requestId);
  return requestId;
}

function buildErrorResponse(c: Context<AppEnv>, err: unknown) {
  const requestId = getRequestId(c);
  const message = err instanceof Error ? err.message : 'Unknown error'
  const stack = err instanceof Error ? err.stack?.slice(0, 500) : undefined
  const status = typeof err === 'object' && err !== null && 'status' in err
    ? Number((err as { status?: unknown }).status) || 500
    : 500
  const code = typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code || 'INTERNAL_ERROR')
    : 'INTERNAL_ERROR'
  const isProd = c.env?.ENVIRONMENT === 'production'
  const expectedCodes = new Set([
    'AUTHENTICATION_ERROR',
    'AUTHORIZATION_ERROR',
    'VALIDATION_ERROR',
    'RATE_LIMIT_EXCEEDED',
    'NOT_FOUND',
    'CONFLICT',
  ])
  const isHandledClientError = status < 500 || expectedCodes.has(code)

  if (isHandledClientError) {
    console.warn(JSON.stringify({
      level: 'warn',
      type: 'handled',
      requestId,
      code,
      status,
      error: message,
      ts: new Date().toISOString(),
    }))
  } else {
    console.error(JSON.stringify({
      level: 'error',
      type: 'unhandled',
      requestId,
      code,
      status,
      error: message,
      stack,
      ts: new Date().toISOString(),
    }))
  }

  return {
    status: status as AppJsonInit,
    payload: {
      error: {
        code,
        message: isProd && status === 500 ? 'Internal server error' : message,
        status,
        requestId,
        timestamp: new Date().toISOString(),
      }
    }
  }
}

app.onError((err, c) => {
  const response = buildErrorResponse(c, err)
  return c.json(response.payload, response.status)
})

// ═══ CORS: strict allowlist for preflight and actual requests ═══
app.use('*', async (c, next) => {
  const requestedOrigin = normalizeOrigin(c.req.header('Origin'));
  const allowedOrigins = buildAllowedOrigins(c);
  const isAllowedOrigin = !!requestedOrigin && allowedOrigins.has(requestedOrigin);

  if (c.req.method === 'OPTIONS') {
    applyCorsBaseHeaders(c);
    if (requestedOrigin && !isAllowedOrigin) {
      logger.warn('Rejected CORS preflight from unauthorized origin', { origin: requestedOrigin, path: c.req.path });
      return c.json(
        { error: { code: 'AUTHORIZATION_ERROR', message: 'CORS origin not allowed' } },
        403,
      );
    }

    if (requestedOrigin && isAllowedOrigin) {
      applyCorsHeaders(c, requestedOrigin);
    }
    return c.body(null, 204);
  }

  if (requestedOrigin && isAllowedOrigin) {
    applyCorsHeaders(c, requestedOrigin);
  } else if (requestedOrigin && !isAllowedOrigin) {
    logger.warn('Rejected CORS request from unauthorized origin', { origin: requestedOrigin, path: c.req.path });
  }

  await next()
})

// ═══ Security Headers Middleware ═══
app.use('*', async (c, next) => {
  // Generate nonce for CSP
  const nonce = crypto.randomUUID();
  c.set('cspNonce', nonce);

  await next()

  c.header('Content-Security-Policy', buildCspHeader(c, nonce))

  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('X-XSS-Protection', '0')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()')
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')
  c.header('Cross-Origin-Opener-Policy', 'same-origin')
  c.header('Cross-Origin-Embedder-Policy', 'credentialless')
  c.header('Cross-Origin-Resource-Policy', 'same-origin')
})

// ═══ Runtime configuration guard (fail closed in production) ═══
app.use('*', async (c, next) => {
  const issues = getRuntimeConfigurationIssues(c);
  if (issues.length > 0) {
    logger.fatal('Runtime configuration invalid for production environment', { issues });
    throw new AppError('Runtime configuration invalid', 'CONFIGURATION_ERROR', 500, { issues });
  }
  await next();
})

// ═══ Request Logger Middleware ═══
app.use('*', async (c, next) => {
  const start = Date.now()
  const requestId = getRequestId(c);
  console.log(JSON.stringify({
    level: 'info',
    type: 'request',
    requestId,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    ip: getAnonymizedIP(c),
    ua: c.req.header('user-agent')?.slice(0, 100),
    ts: new Date().toISOString(),
  }))

  await next()

  const duration = Date.now() - start
  console.log(JSON.stringify({
    level: 'info',
    type: 'response',
    requestId,
    status: c.res.status,
    duration,
    ts: new Date().toISOString(),
  }))
})

// ═══ Global Error Handler ═══
app.use('*', async (c, next) => {
  try {
    await next()
  } catch (err: unknown) {
    const response = buildErrorResponse(c, err)
    return c.json(response.payload, response.status)
  }
})

// ═══ API Rate Limiter (shared middleware) ═══
app.use('/api/*', rateLimiter({
  windowMs: 60_000,
  maxRequests: 120,
  keyPrefix: 'rl:api',
  useKV: true,
}))

// ═══ Health Check ═══
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '3.0.0',
    environment: c.env?.ENVIRONMENT || 'development',
    uptime: process.uptime ? Math.floor(process.uptime()) : undefined,
    features: {
      matching: true,
      realtime: true,
      pwa: true,
      encryption: true,
      mfa: true,
    }
  })
})

// ═══ API Routes (mounted from route modules) ═══

app.get('/api/hello', (c) => {
  return c.json({ message: 'Hello from Klubz API!' })
})

// Auth routes: /api/auth/login, /api/auth/register, /api/auth/refresh, /api/auth/logout
app.route('/api/auth', authRoutes)

// User routes: /api/users/profile, /api/users/trips, /api/users/preferences
app.route('/api/users', userRoutes)

// Trip routes: /api/trips/available, /api/trips/:id/book, /api/trips/offer, etc.
app.route('/api/trips', tripRoutes)

// Admin routes: /api/admin/stats, /api/admin/users, /api/admin/logs, etc.
app.route('/api/admin', adminRoutes)

// Monitoring routes: /api/monitoring/metrics, /api/monitoring/sla, etc.
app.route('/api/monitoring', monitoringRoutes)

// Payment routes: /api/payments/intent, /api/payments/webhook
app.route('/api/payments', paymentRoutes)

// Notification routes: /api/notifications
app.route('/api/notifications', notificationRoutes)

// Smart Trip Pooling - Matching Engine API
const matchingRoutes = createMatchingRoutes()
app.route('/api/matching', matchingRoutes)

// ═══ Real-Time Events (SSE) ═══
app.get('/api/events', authMiddleware(), async (c) => {
  const user = c.get('user') as AuthUser;
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  await writer.write(encoder.encode(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`))

  // Subscribe to event bus for real events
  const unsubscribe = eventBus.onAll(async (event) => {
    if (!isEventVisibleToUser(event, user)) {
      return;
    }
    try {
      await writer.write(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
    } catch { /* client disconnected */ }
  })

  const heartbeat = setInterval(async () => {
    try {
      await writer.write(encoder.encode(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`))
    } catch {
      clearInterval(heartbeat)
    }
  }, 30000)

  c.req.raw.signal.addEventListener('abort', () => {
    clearInterval(heartbeat)
    unsubscribe()
    writer.close().catch(() => {})
  })

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})

// ═══ PWA Application Shell ═══
app.get('/', (c) => {
  const html = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover">
  <meta name="description" content="Klubz - Intelligent carpooling that reduces costs, carbon emissions, and commute stress">
  <meta name="theme-color" content="#3B82F6" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#0F172A" media="(prefers-color-scheme: dark)">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Klubz">
  <meta name="application-name" content="Klubz">
  <meta name="msapplication-TileColor" content="#3B82F6">
  <meta name="mobile-web-app-capable" content="yes">

  <!-- Open Graph -->
  <meta property="og:title" content="Klubz - Smart Carpooling">
  <meta property="og:description" content="Intelligent carpooling that reduces costs, carbon emissions, and commute stress">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://klubz-production.pages.dev">

  <title>Klubz - Smart Carpooling</title>

  <!-- PWA Manifest -->
  <link rel="manifest" href="/manifest.json">

  <!-- Icons -->
  <link rel="icon" type="image/svg+xml" href="/static/icons/icon-192x192.svg">
  <link rel="apple-touch-icon" href="/static/icons/icon-192x192.svg">

  <!-- Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">

  <!-- Styles -->
  <link rel="stylesheet" href="/static/style.css">

  <!-- Preload critical assets -->
  <link rel="preload" href="/static/js/app.js" as="script">
</head>
<body>
  <div id="app-root">
    <!-- App shell rendered by JS -->
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;min-height:100dvh;background:var(--bg-primary)">
      <div style="text-align:center">
        <div style="font-size:2.5rem;font-weight:800;color:var(--primary);margin-bottom:0.5rem">Klubz</div>
        <div style="width:40px;height:4px;background:var(--primary);border-radius:2px;margin:0 auto;animation:pulse 1.5s infinite"></div>
      </div>
    </div>
  </div>

  <!-- Application Script -->
  <script src="/static/js/app.js" defer></script>

  <!-- Noscript fallback -->
  <noscript>
    <div style="padding:2rem;text-align:center;font-family:system-ui;background:#0F172A;color:#F8FAFC;min-height:100vh;display:flex;align-items:center;justify-content:center">
      <div>
        <h1 style="font-size:1.5rem;margin-bottom:0.5rem">Klubz</h1>
        <p style="color:#94A3B8">JavaScript is required to run this application. Please enable JavaScript in your browser settings.</p>
      </div>
    </div>
  </noscript>
</body>
</html>`

  return c.html(html)
})

// ═══ Admin Portal ═══
app.get('/admin/*', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="en" data-theme="dark">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Klubz Admin Portal</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
        <link href="/static/css/admin.css" rel="stylesheet">
    </head>
    <body class="bg-gray-900 text-gray-100" style="font-family:'Inter',sans-serif">
        <div id="root"></div>
        <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
        <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
        <script src="/static/js/admin.js"></script>
    </body>
    </html>
  `)
})

// ═══ Catch-all: serve PWA for client-side routing ═══
app.get('*', (c) => {
  const path = new URL(c.req.url).pathname
  if (path.startsWith('/api/') || path.startsWith('/static/')) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } }, 404)
  }
  return c.redirect('/', 302)
})

export default app
