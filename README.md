# MP Tetris — Online 1v1 Multiplayer Tetris

Browser-based 1v1 online Tetris with full guideline rules, three.js 3D rendering, and
lockstep netcode over WebSockets. Clear lines to bury your opponent in garbage rows;
first to top out loses.

## Architecture

- **Client** — Vite + TypeScript + three.js. Each client simulates *both* boards locally
  from a shared randomizer seed + tick-aligned input stream (60 Hz fixed ticks, 150 ms
  input delay buffer). Both playfields and the opponent's next-piece queue are always visible.
- **Server** — Node.js + TypeScript relay on port 6000: rooms/lobby, presence, input & hash
  forwarding, highscore persistence. No game logic; trivially restartable.
- **Netcode** — deterministic lockstep. Only raw inputs cross the wire; line clears, garbage,
  and top-out are derived identically on both clients. Periodic FNV-1a state hashes verify
  sync; on mismatch a full-state "adopt" resync re-aligns both clients (lossless).

## Rules

- Full guideline: SRS rotation + wall kicks, 7-bag randomizer, hold, ghost piece, DAS/ARR,
  standard scoring (back-to-back, combos, T-spins), level-based gravity.
- Clearing N lines inserts **N complete solid rows at the bottom of the opponent's field**,
  pushing their stack up. Top-out = loss.

## Controls

| Key | Action |
|---|---|
| ← / → (or A/D) | Move |
| ↓ (or S) | Soft drop |
| ↑ / X (or W) | Rotate CW |
| Z | Rotate CCW |
| Space | Hard drop |
| C / Shift | Hold |
| P / Esc | Pause (hides your board; opponent keeps playing) |

## Local development

```bash
npm install
npm run dev:server    # relay on :6000
npm run dev:client    # vite on :5173, proxies /ws to :6000
# open http://localhost:5173 in two browser windows (or a window + incognito)
```

## Production build & Docker (LXC)

```bash
docker compose up -d --build
```

The container listens on **port 6000** and serves both the static frontend and the WebSocket
API. Highscores persist in the `mp-tetris-data` volume (`/app/data/scores.json`).

### nginx reverse proxy (TLS)

Your existing nginx on :80/:443 should forward to the container. Example server block for
`tetris.bornsnyder.duckdns.org`:

```nginx
server {
    listen 80;
    server_name tetris.bornsnyder.duckdns.org;
    # Let's Encrypt HTTP-01 (if using certbot):
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name tetris.bornsnyder.duckdns.org;
    ssl_certificate     /etc/letsencrypt/live/tetris.bornsnyder.duckdns.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tetris.bornsnyder.duckdns.org/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:6000;   # or the LXC's IP if nginx runs elsewhere
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # required for WebSocket
        proxy_set_header Connection "upgrade";       # required for WebSocket
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;                    # keep idle WS connections alive
    }
}
```

Players then use `https://tetris.bornsnyder.duckdns.org` (WebSocket upgrades to `wss://` automatically).

## Testing

```bash
npm run test:harness
```

Spins up the real server on :6100, connects two scripted bots over WebSocket, plays full
matches to top-out, and verifies: lobby flow, lockstep integrity (zero hash mismatches),
agreement on winner/scores, highscore recording, determinism, and garbage mechanics.

## Project layout

```
shared/           protocol types + deterministic game logic (engine, pieces, inputs)
server/src/       Node relay: index.ts (http+ws), rooms.ts, scores.ts
client/           Vite app: main.ts (state machine), render/scene3d.ts, net/, audio/
test/harness.ts   headless two-client match verification
```
