# Auto Upload Script

Automatically watches a folder and uploads new or modified files to an FTP server.

## Features

- Real-time file monitoring with chokidar
- Automatic FTP upload on file changes
- Retry logic with exponential backoff
- Tracks uploaded files to avoid duplicates
- Preserves directory structure on remote server
- Graceful shutdown with state persistence

## Setup

1. Install dependencies:
```bash
bun install
```

2. Create a `.env` file with your FTP credentials:
```env
FTP_HOST=your-ftp-server.com
FTP_PORT=21
FTP_USER=your-username
FTP_PASSWORD=your-password
FTP_SECURE=false

# Optional retry configuration
FTP_MAX_RETRIES=3
FTP_RETRY_DELAY_MS=1000
FTP_MAX_RETRY_DELAY_MS=30000
FTP_BACKOFF_MULTIPLIER=2
```

## Usage

```bash
bun run index.ts <folder-to-watch>
```

Example:
```bash
bun run index.ts C:\MyDocuments\uploads
```

The script will monitor the specified folder and automatically upload any new or modified files to your FTP server.

## How It Works

- Watches the specified folder for file additions and changes
- Uploads files to the FTP server maintaining the same directory structure
- Saves a list of uploaded files in `uploaded-files.json`
- Retries failed uploads with exponential backoff
- Press Ctrl+C to stop (saves state before exiting)
