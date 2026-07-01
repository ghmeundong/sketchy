# Development

## Prerequisites

- Node.js 18+
- npm or yarn
- Wrangler CLI (for Cloudflare Workers development)

## Environment Setup

### 1. Install Dependencies

```bash
# Install frontend dependencies
npm install

# Install backend dependencies
cd backend
npm install
cd ..
```

### 2. Configure Environment Variables

Create `.env.local` in the root directory (if needed for Supabase):

```env
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_key
```

### 3. Configure Backend (wrangler.toml)

Ensure `backend/wrangler.toml` has the correct R2 binding:

```toml
[[r2_bindings]]
binding = "SKETCHES_BUCKET"
bucket_name = "sketchy-sketches"
```

## Development Commands

### Frontend Only

```bash
npm run dev
```

Starts Vite development server at `http://localhost:5173`

### Backend Only

```bash
cd backend
npm run dev
```

Starts Wrangler dev server at `http://localhost:8787`

### Full Stack Development

```bash
npm run dev:full
```

Runs both frontend and backend concurrently using `concurrently`.

## Code Quality

### Linting

```bash
npm run lint
```

Runs:
- ESLint for JavaScript code
- Stylelint for CSS files

### Formatting

```bash
npm run format
```

Formats all code with Prettier.

### Fix Issues Automatically

```bash
npm run lint -- --fix
```

## Testing

```bash
# Run tests once
npm run test

# Run tests in watch mode
npm run test:watch
```

## Git Hooks

Husky automatically runs pre-commit and pre-push hooks:

- **pre-commit**: Runs Prettier and ESLint on staged files
- **pre-push**: Runs full linting suite

## Debugging

### Browser Console

Check API connectivity:

```javascript
fetch('/api/health')
  .then(r => r.json())
  .then(j => console.log('API:', j))
  .catch(e => console.error('API error:', e));
```

### Worker Logs

When running `npm run dev:backend`, logs appear in the terminal.

## Common Issues

### Port Already in Use

If port 5173 (frontend) or 8787 (backend) is in use:

```bash
# Frontend
npm run dev -- --port 3000

# Backend
cd backend && npm run dev -- --port 8786
```

### R2 Binding Not Found

Ensure `wrangler.toml` includes the R2 binding configuration and run:

```bash
cd backend && npm run dev
```
