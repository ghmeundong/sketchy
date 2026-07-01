# Architecture

## Overview

Sketchy is a collaborative sketching application with a clear separation of concerns between frontend and backend.

## Frontend Architecture

The frontend is a Vite-based single-page application built with vanilla JavaScript.

### Key Components

- **Canvas Rendering**: Uses HTML5 Canvas API for drawing
- **Rough.js Integration**: Provides hand-drawn aesthetic for sketches
- **State Management**: Manages drawing state, snapshots, and synchronization
- **Services**:
  - `api.js`: Handles communication with the backend Worker
  - `supabase.js`: Manages Supabase integration for authentication/data
  - `canvas-utils.js`: Utility functions for canvas manipulation and resizing

### Drawing Modes

- **Pencil**: Precise, thin line drawing
- **Crayon**: Thick, textured strokes
- **Brush**: Variable-width brush strokes

### Key Features

- **Live Drawing**: Real-time canvas manipulation
- **Snapshots**: Captures current canvas state as image data
- **Replay**: Stores and replays drawing sequences
- **Responsive Design**: Adapts to different screen sizes

## Backend Architecture

The backend is a Cloudflare Worker providing API endpoints and cloud storage integration.

### Responsibilities

- **API Endpoints**:
  - `/api/health` - Health check
  - Data synchronization endpoints
  - File upload/download from R2

- **R2 Integration**:
  - Stores sketch data as JSON files
  - Stores image snapshots
  - Supports concurrent access with CORS headers

- **CORS Handling**: Enables cross-origin requests from frontend

### Environment Configuration

```toml
# wrangler.toml
[[r2_bindings]]
binding = "SKETCHES_BUCKET"
bucket_name = "sketchy-sketches"
```

## Data Flow

```
User Input → Canvas Drawing → Local State
                    ↓
            Serialize to JSON
                    ↓
         Send to Worker API
                    ↓
         Store in R2 Bucket
```

## Storage

- **R2 Bucket**: Persistent storage for sketch data and snapshots
- **File Format**: JSON with embedded base64 image data
- **Document IDs**: Support for shared and user-specific sketches

## Technology Stack

- **Frontend**: Vite, Vanilla JS, Canvas API, Rough.js
- **Backend**: Cloudflare Workers
- **Storage**: Cloudflare R2
- **Styling**: CSS3 with custom properties
- **Build Tools**: ESLint, Prettier, Stylelint, Husky
