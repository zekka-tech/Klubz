import { Hono } from 'hono'
import { createMatchingRoutes } from './routes/matching'
import { authRoutes } from './routes/auth'
import { userRoutes } from './routes/users'
import { tripRoutes } from './routes/trips'
import { adminRoutes } from './routes/admin'
import { monitoringRoutes } from './routes/monitoring'
import { paymentRoutes } from './routes/payments'
import { eventBus } from './lib/eventBus'
import { logger } from './lib/logger'
import { anonymizeIP } from './lib/privacy'
import type { AppEnv } from './types'

const app = new Hono<AppEnv>()

// ═══ Early CORS: handle preflight before anything else ═══
app.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': c.req.header('Origin') || '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-ID, X-CSRF-Token',
        'Access-Control-Max-Age': '86400',
      }
    })
  }
  await next()
})

// ═══ Security Headers Middleware ═══
app.use('*', async (c, next) => {
  // Generate nonce for CSP
  const nonce = crypto.randomUUID();
  c.set('cspNonce', nonce);

  await next()

  c.header('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://cdn.tailwindcss.com https://unpkg.com https://cdn.jsdelivr.net`,
    `style-src 'self' 'nonce-${nonce}' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://fonts.googleapis.com https://cdn.jsdelivr.net`,
    "font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://api.klubz.com wss:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '))

  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('X-XSS-Protection', '1; mode=block')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()')
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')
  c.header('Cross-Origin-Opener-Policy', 'same-origin')
  c.header('Cross-Origin-Embedder-Policy', 'credentialless')
})

// ═══ CORS Headers (for non-OPTIONS) ═══
app.use('*', async (c, next) => {
  const origin = c.req.header('Origin') || ''
  const allowed = ['https://klubz-production.pages.dev', 'https://klubz-staging.pages.dev', 'http://localhost:3000', 'http://localhost:3001']

  if (allowed.includes(origin)) {
    // Only allow whitelisted origins
    c.header('Access-Control-Allow-Origin', origin)
    c.header('Access-Control-Allow-Credentials', 'true')
  } else if (origin) {
    // Log suspicious requests from unauthorized origins
    logger.warn('Rejected CORS request from unauthorized origin', { origin, path: c.req.path })
  }
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-ID, X-CSRF-Token')
  c.header('Access-Control-Max-Age', '86400')
  c.header('Access-Control-Expose-Headers', 'X-Request-ID, X-RateLimit-Remaining')

  await next()
})

// ═══ Request Logger Middleware ═══
app.use('*', async (c, next) => {
  const start = Date.now()
  const requestId = c.req.header('X-Request-ID') || crypto.randomUUID()
  c.header('X-Request-ID', requestId)

  const rawIP = c.req.header('CF-Connecting-IP') || c.req.header('x-forwarded-for') || 'unknown';
  console.log(JSON.stringify({
    level: 'info',
    type: 'request',
    requestId,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    ip: anonymizeIP(rawIP),
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
  } catch (err: any) {
    const requestId = c.req.header('X-Request-ID') || crypto.randomUUID()

    console.error(JSON.stringify({
      level: 'error',
      type: 'unhandled',
      requestId,
      error: err.message,
      stack: err.stack?.slice(0, 500),
      ts: new Date().toISOString(),
    }))

    const status = err.status || 500
    const isProd = c.env?.ENVIRONMENT === 'production'

    return c.json({
      error: {
        code: err.code || 'INTERNAL_ERROR',
        message: isProd && status === 500 ? 'Internal server error' : err.message,
        status,
        requestId,
        timestamp: new Date().toISOString(),
      }
    }, status)
  }
})

// ═══ Rate Limiter (TTL-evicting in-memory store) ═══
const rateLimitStore = new Map<string, { count: number; reset: number }>()
let lastRLSweep = 0

app.use('/api/*', async (c, next) => {
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('x-forwarded-for') || 'unknown'
  const key = `rl:${ip}`
  const now = Date.now()
  const window = 60_000
  const maxReqs = 120

  let entry = rateLimitStore.get(key)
  // Lazy expiry: if expired, treat as new window
  if (!entry || now > entry.reset) {
    entry = { count: 0, reset: now + window }
    rateLimitStore.set(key, entry)
  }
  entry.count++

  // Periodic TTL sweep (every 30s, up to 2000 entries)
  if (now - lastRLSweep > 30_000) {
    lastRLSweep = now
    let evicted = 0
    for (const [k, v] of rateLimitStore) {
      if (now > v.reset) { rateLimitStore.delete(k); evicted++; }
      if (evicted > 2000) break
    }
  }

  c.header('X-RateLimit-Limit', maxReqs.toString())
  c.header('X-RateLimit-Remaining', Math.max(0, maxReqs - entry.count).toString())
  c.header('X-RateLimit-Reset', new Date(entry.reset).toISOString())

  if (entry.count > maxReqs) {
    return c.json({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please try again later.',
        retryAfter: Math.ceil((entry.reset - now) / 1000),
      }
    }, 429)
  }

  await next()
})

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

// Smart Trip Pooling - Matching Engine API
const matchingRoutes = createMatchingRoutes()
app.route('/api/matching', matchingRoutes)

// ═══ Real-Time Events (SSE) ═══
app.get('/api/events', async (c) => {
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  await writer.write(encoder.encode(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`))

  // Subscribe to event bus for real events
  const unsubscribe = eventBus.onAll(async (event) => {
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
