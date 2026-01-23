import { Hono } from 'hono'
import { renderer } from './renderer'

// Simple CORS middleware
const cors = () => {
  return async (c: any, next: any) => {
    c.header('Access-Control-Allow-Origin', '*')
    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    
    if (c.req.method === 'OPTIONS') {
      return c.text('OK', 200)
    }
    
    await next()
  }
}

// Simple logger middleware
const logger = () => {
  return async (c: any, next: any) => {
    console.log(`[${new Date().toISOString()}] ${c.req.method} ${c.req.url}`)
    await next()
  }
}

// Simple error handler
const errorHandler = () => {
  return async (c: any, next: any) => {
    try {
      await next()
    } catch (err: any) {
      console.error('Error:', err)
      return c.json({
        error: {
          message: err.message || 'Internal server error',
          status: err.status || 500,
          timestamp: new Date().toISOString()
        }
      }, err.status || 500)
    }
  }
}

const app = new Hono()

// Apply middleware
app.use('*', logger())
app.use('*', cors())
app.use('*', errorHandler())
app.use(renderer)

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    environment: 'development'
  })
})

// API routes - simplified for now
app.get('/api/hello', (c) => {
  return c.json({ message: 'Hello from Klubz API!' })
})

// Main application route
app.get('/', (c) => {
  return c.render(
    <div class="min-h-screen bg-gray-100">
      <nav class="bg-white shadow-sm">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div class="flex justify-between h-16">
            <div class="flex items-center">
              <h1 class="text-2xl font-bold text-gray-900">Klubz</h1>
              <span class="ml-2 text-sm text-gray-500">Enterprise Carpooling Platform</span>
            </div>
            <div class="flex items-center space-x-4">
              <a href="/admin" class="text-gray-700 hover:text-gray-900">Admin Portal</a>
              <a href="/login" class="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700">Login</a>
            </div>
          </div>
        </div>
      </nav>

      <main class="max-w-7xl mx-auto py-12 px-4 sm:px-6 lg:px-8">
        <div class="text-center">
          <h2 class="text-4xl font-bold text-gray-900 mb-4">
            Transform Your Enterprise Transportation
          </h2>
          <p class="text-xl text-gray-600 mb-8">
            Intelligent carpooling that reduces costs, carbon emissions, and commute stress
          </p>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-8 mt-12">
            <div class="bg-white p-6 rounded-lg shadow-md">
              <div class="text-blue-600 text-3xl mb-4">🚗</div>
              <h3 class="text-lg font-semibold mb-2">Smart Matching</h3>
              <p class="text-gray-600">AI-powered rider-driver matching for optimal routes</p>
            </div>
            <div class="bg-white p-6 rounded-lg shadow-md">
              <div class="text-green-600 text-3xl mb-4">🌱</div>
              <h3 class="text-lg font-semibold mb-2">Carbon Tracking</h3>
              <p class="text-gray-600">Monitor and report your environmental impact</p>
            </div>
            <div class="bg-white p-6 rounded-lg shadow-md">
              <div class="text-purple-600 text-3xl mb-4">🔒</div>
              <h3 class="text-lg font-semibold mb-2">Enterprise Security</h3>
              <p class="text-gray-600">POPIA/GDPR compliant with end-to-end encryption</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
})

// Admin portal route
app.get('/admin/*', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Klubz Admin Portal</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    </head>
    <body class="bg-gray-50">
        <div class="min-h-screen flex items-center justify-center">
            <div class="text-center">
                <h1 class="text-4xl font-bold text-gray-900 mb-4">Klubz Admin Portal</h1>
                <p class="text-gray-600 mb-8">Enterprise carpooling platform administration</p>
                <div class="bg-white p-8 rounded-lg shadow-md max-w-md mx-auto">
                    <h2 class="text-xl font-semibold mb-4">Admin Dashboard</h2>
                    <p class="text-gray-600 mb-6">Manage users, trips, organizations, and system settings</p>
                    <div class="space-y-3">
                        <div class="bg-blue-50 p-4 rounded-lg">
                            <div class="flex items-center">
                                <i class="fas fa-users text-blue-600 mr-3"></i>
                                <span>User Management</span>
                            </div>
                        </div>
                        <div class="bg-green-50 p-4 rounded-lg">
                            <div class="flex items-center">
                                <i class="fas fa-route text-green-600 mr-3"></i>
                                <span>Trip Analytics</span>
                            </div>
                        </div>
                        <div class="bg-purple-50 p-4 rounded-lg">
                            <div class="flex items-center">
                                <i class="fas fa-chart-line text-purple-600 mr-3"></i>
                                <span>System Monitoring</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </body>
    </html>
  `)
})

export default app