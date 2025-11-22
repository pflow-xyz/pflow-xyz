# pflow-xyz Webserver

This Go module provides a webserver that serves the pflow-xyz petri-view web component with a compatible backend for saving and managing Petri net models.

## Features

- Serves static files from the `public` directory (embedded in the binary)
- Provides API endpoints for saving, retrieving, and deleting JSON-LD objects
- Uses a backend implementation for CID computation and storage
- Supports GitHub OAuth authentication via Supabase JWT tokens
- CORS support for cross-origin requests

## Building

```bash
go build -o webserver ./cmd/webserver
```

## Running

```bash
# Run with default settings (port 8080, data directory ./data)
./webserver

# Run with custom port and data directory
./webserver -port 9000 -data /path/to/data
```

### Environment Variables

- `SUPABASE_JWT_SECRET`: JWT secret for validating Supabase authentication tokens (required for authentication features)

## API Endpoints

### Static Files

- `GET /` - Serves `index.html`
- `GET /<file>` - Serves static files from the `public` directory

### Object Storage

- `GET /o/{cid}` - Get object by CID
- `DELETE /o/{cid}` - Delete object by CID (requires authentication, author only)
- `POST /api/save` - Save a JSON-LD object and get its CID
- `GET /api/ownership/{cid}` - Check if current user owns an object

### SVG Generation

- `GET /img/{cid}.svg` - Generate SVG representation of a Petri net
  - Supports optional `?layout=<algorithm>` query parameter for automatic layout
  - Available layouts:
    - `circular` or `circle` - Arranges nodes in a circle
    - `force-atlas-2`, `force-atlas`, or `force` - Physics-based force-directed layout
    - `hierarchical`, `hierarchical-vertical`, or `vertical` - Layers nodes vertically
  - Example: `/img/{cid}.svg?layout=force-atlas-2`

## Architecture

This server implements a backend for:
- JSON-LD canonicalization (URDNA2015)
- CID computation (IPFS CIDv1 with SHA2-256)
- Object storage (filesystem-based)
- Authentication (Supabase JWT validation)

The webserver embeds the pflow-xyz `public` directory and provides REST API endpoints for data persistence.

## Development

The webserver embeds the `public` directory at build time, so any changes to the frontend require rebuilding the binary.

For development, you can use a file watcher to rebuild on changes, or run a separate static file server for the frontend.
