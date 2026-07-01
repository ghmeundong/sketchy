# Sketchy

A collaborative web-based sketching application built with Vite and Cloudflare Workers. Draw, sketch, and share your creations with support for multiple drawing modes and real-time synchronization.

## Features

- 🎨 Multiple drawing modes (Pencil, Crayon, Brush)
- 🎬 Drawing replay functionality
- 💾 Cloud storage with Cloudflare R2
- 🔄 Real-time data synchronization
- 🖼️ Canvas snapshot support
- 📱 Responsive design
- ⚡ Vite-based frontend
- 🚀 Cloudflare Workers backend
- 🧹 ESLint + Prettier + Stylelint
- 🪝 Husky + lint-staged for git hooks

## Quick Start

### Frontend

```bash
npm install
npm run dev
```

### Backend

```bash
cd backend
npm install
npm run dev
```

### Full Stack Development

```bash
npm run dev:full
```

## Scripts

- `npm run dev` - Start frontend development server
- `npm run dev:backend` - Start backend development server
- `npm run dev:full` - Start both frontend and backend concurrently
- `npm run build` - Build frontend for production
- `npm run deploy` - Deploy frontend to GitHub Pages
- `npm run lint` - Run ESLint and Stylelint
- `npm run format` - Format code with Prettier
- `npm run test` - Run tests
- `npm run test:watch` - Run tests in watch mode
- `npm run convert-images` - Convert images to optimized formats

## Project Structure

```
.
├── src/                    # Frontend source code
│   ├── main.js            # Application entry point
│   ├── style.css          # Global styles
│   ├── services/          # Service modules
│   │   ├── api.js         # API client
│   │   ├── supabase.js    # Supabase integration
│   │   └── canvas-utils.js # Canvas utilities
│   └── img/               # Image assets
├── backend/               # Cloudflare Workers
│   ├── src/
│   │   └── index.js       # Worker entry point
│   ├── package.json
│   └── wrangler.toml      # Workers configuration
├── public/                # Static assets
├── docs/                  # Documentation
├── scripts/               # Build and utility scripts
└── package.json
```

## Documentation

- [Architecture](./docs/ARCHITECTURE.md) - System design and components
- [Development](./docs/DEVELOPMENT.md) - Development setup and guidelines
- [Deployment](./docs/DEPLOYMENT.md) - Production deployment instructions

## License

MIT
