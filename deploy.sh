#!/bin/bash
# Klubz Manual Deployment Script
# Run this script after configuring Cloudflare API token

set -e

echo "🚀 Starting Klubz Deployment Process..."

# Check if Cloudflare API token is set
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
    echo "❌ CLOUDFLARE_API_TOKEN environment variable is not set"
    echo "Please configure your Cloudflare API token first"
    exit 1
fi

echo "✅ Cloudflare API token detected"

# Step 1: Install dependencies
echo "📦 Installing dependencies..."
npm install

# Step 2: Create D1 database
echo "🗄️ Creating D1 database..."
npx wrangler d1 create klubz-db-prod

# Note: Copy the database ID from the output and manually update wrangler.jsonc
# This is a manual step that requires editing the configuration file

echo "⚠️  IMPORTANT: Please copy the database ID from the output above"
echo "and update wrangler.jsonc with the actual database_id"
echo "Press Enter when you have updated wrangler.jsonc..."
read -p ""

# Step 3: Apply database migrations
echo "📋 Applying database migrations..."
npx wrangler d1 migrations apply klubz-db-prod --local

# Step 4: Load sample data
echo "📊 Loading sample data..."
npx wrangler d1 execute klubz-db-prod --local --file=./migrations/0002_sample_data.sql

# Step 5: Build the project
echo "🏗️ Building project..."
npm run build

# Step 6: Set up environment variables
echo "🔐 Setting up environment variables..."
echo "Please provide the following environment variables:"

read -p "JWT_SECRET (min 256 bits): " jwt_secret
read -p "ENCRYPTION_KEY (32 bytes for AES-256): " encryption_key
read -p "SMS_API_KEY (Twilio): " sms_api_key
read -p "ADMIN_EMAIL: " admin_email

npx wrangler pages secret put JWT_SECRET --project-name klubz-production <<< "$jwt_secret"
npx wrangler pages secret put ENCRYPTION_KEY --project-name klubz-production <<< "$encryption_key"
npx wrangler pages secret put SMS_API_KEY --project-name klubz-production <<< "$sms_api_key"
npx wrangler pages secret put ADMIN_EMAIL --project-name klubz-production <<< "$admin_email"

# Step 7: Deploy to Cloudflare Pages
echo "🌐 Deploying to Cloudflare Pages..."
npm run deploy:prod

echo "✅ Deployment completed!"
echo "🎉 Your Klubz application should be live at: https://klubz-production.pages.dev"
echo ""
echo "Next steps:"
echo "1. Test the application endpoints"
echo "2. Configure custom domain (optional)"
echo "3. Set up monitoring and alerts"
echo "4. Configure backup strategy"