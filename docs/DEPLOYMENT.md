# Deployment

## Prerequisites

- Cloudflare account with Workers and R2 enabled
- GitHub account for frontend deployment (via GitHub Pages)
- Wrangler CLI configured with Cloudflare credentials

## Deploying the Frontend

### To GitHub Pages

```bash
npm run build
npm run deploy
```

This:

1. Builds the frontend with `vite build`
2. Deploys the `dist/` directory to GitHub Pages

**Configure in `package.json`:**

```json
{
  "homepage": "https://yourusername.github.io/sketchy",
  "scripts": {
    "deploy": "gh-pages -d dist"
  }
}
```

### To Custom Domain

1. Build the frontend: `npm run build`
2. Deploy the `dist/` folder to your hosting provider (Vercel, Netlify, etc.)

## Deploying the Backend

### Initial Setup

1. Create an R2 bucket on Cloudflare:

```bash
wrangler r2 bucket create sketchy-sketches
```

2. Configure `backend/wrangler.toml`:

```toml
name = "sketchy-backend"
type = "service"
account_id = "your_account_id"
route = "example.com/api/*"

[[r2_bindings]]
binding = "SKETCHES_BUCKET"
bucket_name = "sketchy-sketches"
```

### Deploy

```bash
cd backend
wrangler login
npm run deploy
```

This:

1. Authenticates with Cloudflare
2. Deploys the Worker to your account
3. Binds to the R2 bucket

## Environment Variables

### Frontend

Set in `.env` or `.env.production`:

```env
VITE_API_BASE_URL=https://api.yourdomain.com
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_key
```

### Backend (Secrets)

Store sensitive values using Wrangler secrets:

```bash
cd backend
wrangler secret put SUPABASE_API_KEY
wrangler secret put DATABASE_URL
```

## Monitoring

### Frontend

- Check GitHub Actions for build status
- Use Cloudflare Analytics for traffic insights

### Backend

- View Worker logs in Cloudflare Dashboard
- Monitor R2 bucket usage and costs
- Set up alerts for failed requests

## Rollback

### Frontend

```bash
# GitHub Pages automatically keeps previous deployments
# To rollback: deploy a previous git commit
git checkout <previous_commit>
npm run deploy
```

### Backend

```bash
cd backend
wrangler rollback
```

## Performance Optimization

### Frontend

1. Enable caching headers:

```bash
# Configure via wrangler.toml or deploy to Cloudflare Pages
```

2. Compress assets:

```bash
npm run build
# Vite automatically minifies and compresses
```

### Backend

1. Set appropriate Cache-Control headers in responses
2. Enable Workers KV for frequently accessed data
3. Monitor and optimize R2 read/write operations

## Troubleshooting

### Build Fails

```bash
npm run lint
npm run build -- --debug
```

### Deploy Fails

```bash
# Check credentials
wrangler whoami

# Check account ID
wrangler deployments list

# Test locally first
npm run dev:full
```

### R2 Access Issues

```bash
# Verify bucket exists
wrangler r2 bucket list

# Check permissions
wrangler r2 object list sketchy-sketches
```
