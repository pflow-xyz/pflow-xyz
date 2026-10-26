# pflow-xyz Webserver

This Go module provides a webserver that serves the pflow-xyz petri-view web component with a compatible backend for saving and managing Petri net models.

## Features

- Serves static files from the `public` directory (embedded in the binary)
- Provides API endpoints for saving, retrieving, and deleting JSON-LD objects
- Uses a backend implementation for CID computation and storage
- Supports GitHub OAuth authentication via JWT tokens
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

- `JWT_SECRET`: Secret key for signing and verifying JWT tokens (required for authentication features)
- `GITHUB_CLIENT_ID`: GitHub OAuth App client ID (required for GitHub login)
- `GITHUB_CLIENT_SECRET`: GitHub OAuth App client secret (required for GitHub login)

### Setting up GitHub OAuth

1. Go to https://github.com/settings/developers
2. Click "New OAuth App"
3. Fill in the details:
   - Application name: Your app name
   - Homepage URL: Your app URL
   - Authorization callback URL: `https://your-domain.com/auth/github/callback`
4. Copy the Client ID and generate a Client Secret
5. Set the environment variables:
   ```bash
   export GITHUB_CLIENT_ID=your_client_id
   export GITHUB_CLIENT_SECRET=your_client_secret
   export JWT_SECRET=your_random_secret_key
   ```

## API Endpoints

### Static Files

- `GET /` - Serves `index.html`
- `GET /<file>` - Serves static files from the `public` directory

### Authentication

- `GET /auth/github` - Initiate GitHub OAuth flow (redirects to GitHub)
- `GET /auth/github/callback` - Handle GitHub OAuth callback (returns JWT token)
- `GET /auth/user` - Get current user info (requires Authorization header)

### Object Storage

- `GET /o/{cid}` - Get object by CID
- `DELETE /o/{cid}` - Delete object by CID (requires authentication, author only)
- `POST /api/save` - Save a JSON-LD object and get its CID
- `GET /api/ownership/{cid}` - Check if current user owns an object

### Account files

Each signed-in user's own files, kept apart per account under `<data>/files/`.
This is where the editor saves what pflow-native would write to disk. See
[docs/account-files.md](docs/account-files.md).

- `GET /api/files/status` - Whether this server keeps account files (no sign-in needed)
- `GET /api/files` - List your files (name, size, modified, kind), your usage and the limits
- `GET /api/files/{name}` - Read one of your files
- `PUT /api/files/{name}` - Save the body as `name`. If you already have that name, you get 409 unless you pass `?overwrite=true`
- `DELETE /api/files/{name}` - Delete one of your files

Every file route needs `Authorization: Bearer <GitHub token>`, where the token must be one this
server's GitHub OAuth app issued (the editor's sign-in; checked with GitHub's app-bound token API, so
personal access tokens and other sites' tokens are refused), and answers only same-origin requests.
Account files are off without `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`. Limits:
`PFLOW_FILES_MAX_FILE_BYTES` (1 MiB), `PFLOW_FILES_MAX_FILES` (200), `PFLOW_FILES_MAX_TOTAL_BYTES`
(20 MiB per account), `PFLOW_FILES_MAX_ROOT_BYTES` (1 GiB across accounts); `PFLOW_FILES_ALLOW`
(comma-separated GitHub logins) narrows who may keep files.

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
- Authentication (GitHub OAuth with JWT tokens)

The webserver embeds the pflow-xyz `public` directory and provides REST API endpoints for data persistence.

## Development

The webserver embeds the `public` directory at build time, so any changes to the frontend require rebuilding the binary.

For development, you can use a file watcher to rebuild on changes, or run a separate static file server for the frontend.
