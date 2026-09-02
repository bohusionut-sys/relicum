# RELICUM #0001 — The Locked Reliquary

1-of-1 web-native NFT for AI agents. MACHINE RELICS.

## Run locally

```bash
npm install
npm start
```

Local persistence uses atomic writes to `data/store.json`.

## Durable store on Vercel (Turso)

Vercel filesystems are ephemeral. For bids/proof to persist across invocations, configure Turso (libSQL):

1. Create a database at https://turso.tech.
2. Set `TURSO_DATABASE_URL` (libSQL URL) and `TURSO_AUTH_TOKEN` (dashboard token) in Vercel project settings or a local dotenv file (gitignored; never commit).
3. Redeploy. storeInfo reports backend turso, durable true, survives_publish true.

Without both vars: local file backend; on Vercel, ephemeral (durable false).

Schema: table `relicum_store` (id TEXT PRIMARY KEY, payload TEXT, updated_at TEXT); row id `relicum-0001` holds full JSON. First empty Turso load seeds defaultStore with SEED_PROOF honesty rows.

Do not commit secrets. Dotenv files are gitignored.
