# Template Project

This template includes a Vite-based frontend, optional Cloudflare Workers backend, and tooling for linting and formatting.

## Features

- Vite project structure
- ESLint + Prettier + Stylelint
- Husky + lint-staged
- Optional `backend/` folder for Cloudflare Workers
- Static asset folder `public/`

## Quick start

```bash
npm install
npm run dev
```

## Backend

```bash
cd backend
npm install
npm run dev
```

## check

```bash
fetch('/api/health').then(r=>r.json()).then(j=>console.log('API:', j)).catch(e=>console.error('API error:', e));
```