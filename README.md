# ⚡ SwiftDrop

**Instantly transfer files from your phone to your computer — no app, no account, just scan a QR code.**

> Works like AirDrop but through any browser. Simply open SwiftDrop on your computer, scan the QR code with your phone, choose your files, and they appear on your desktop instantly.

---

## Features

- **Zero friction** — scan and send in under 10 seconds
- **QR Code sessions** — each session has a unique, auto-expiring QR code (30 min)
- **Real-time delivery** — files appear instantly via Server-Sent Events (SSE)
- **One-time downloads** — files auto-delete after download
- **Large file support** — up to 2 GB per file
- **Multiple file upload** — send several files at once with progress bars
- **No dependencies** — zero npm packages; runs on pure Node.js built-ins
- **Mobile-first** — beautiful upload UI optimized for phones
- **Dark mode** — full dark mode support via CSS `prefers-color-scheme`
- **Secure** — session tokens, rate limiting, dangerous file type blocking

---

## Quick Start

```bash
# Clone or download the project
cd swiftdrop

# Start the server (no npm install needed!)
node server.js
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## How It Works

```
Desktop Browser                     Mobile Browser
──────────────                      ──────────────
1. Open http://your-server          
2. Session ID auto-generated         
3. QR Code displayed                 
4. SSE connection opens              
                                     5. Scan QR code
                                     6. Mobile page opens
                                     7. Select files
                                     8. POST /api/sessions/:id/upload
9. SSE event: files:received ←──────
10. File appears in desktop UI       
11. Click Download                   
12. GET /api/files/:id/download      
13. File streams to computer         
14. File auto-deleted from server    
```

---

## Project Structure

```
swiftdrop/
├── server.js          # Zero-dependency Node.js HTTP server
├── package.json       # Project metadata
├── Dockerfile         # Container build file
├── docker-compose.yml # Docker Compose for easy deployment
├── .env.example       # Environment variable template
├── uploads/           # Temporary file storage (auto-cleaned)
└── public/
    ├── index.html     # Single HTML file (desktop + mobile)
    ├── style.css      # Full design system — dark mode, animations
    ├── app.js         # Frontend JS: routing, desktop, mobile modules
    └── favicon.svg    # SwiftDrop lightning bolt logo
```

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/api/health` | Health check |
| `POST` | `/api/sessions` | Create new transfer session |
| `GET`  | `/api/sessions/:id` | Validate session |
| `POST` | `/api/sessions/:id/upload` | Upload files (multipart) |
| `GET`  | `/api/sessions/:id/events` | SSE stream for desktop |
| `GET`  | `/api/files/:id/download` | Download file (one-time) |
| `GET`  | `/s/:sessionCode` | Mobile upload page |

---

## Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
PORT=3000                     # Server port
SESSION_EXPIRY_MS=1800000     # 30 minutes
MAX_FILE_SIZE=2147483648      # 2 GB
```

---

## Deployment

### Direct (any server with Node 18+)

```bash
# Copy files to your server
scp -r swiftdrop/ user@your-server:~/swiftdrop

# Start
ssh user@your-server "cd swiftdrop && node server.js"
```

### With PM2 (recommended for production)

```bash
npm install -g pm2
pm2 start server.js --name swiftdrop
pm2 save
pm2 startup
```

### Docker

```bash
docker compose up -d
```

### Nginx reverse proxy (HTTPS)

```nginx
server {
    listen 443 ssl;
    server_name swiftdrop.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/swiftdrop.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/swiftdrop.yourdomain.com/privkey.pem;

    # Important: increase for large file uploads
    client_max_body_size 2G;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;

        # SSE support
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts for large uploads
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

---

## Security

- **Session tokens** — cryptographically random 6-char codes
- **Session expiry** — automatic 30-minute TTL
- **One-time downloads** — files deleted immediately after download
- **File type blocking** — `.exe`, `.bat`, `.sh`, `.ps1`, `.msi` etc. blocked
- **Rate limiting** — 60 API requests / minute / IP (in-memory)
- **Path traversal protection** — `..` stripped from all file paths
- **No persistent storage** — files live only in memory until download

---

## Upgrading to Production Scale

| Feature | Current | Production Upgrade |
|---------|---------|-------------------|
| Storage | Local disk | AWS S3 / Cloudflare R2 |
| Sessions | In-memory Map | Redis with TTL |
| Server | Single process | PM2 cluster / K8s |
| Real-time | SSE | Socket.IO or WebSockets |
| Auth | Anonymous | User accounts (JWT) |
| Encryption | TLS via Nginx | E2E encryption (WebCrypto) |

---

## Browser Support

| Browser | Desktop | Mobile |
|---------|---------|--------|
| Chrome 80+ | ✅ | ✅ |
| Firefox 75+ | ✅ | ✅ |
| Safari 14+ | ✅ | ✅ |
| Edge 80+ | ✅ | ✅ |

---

## License

MIT © SwiftDrop
