"use strict";

/**
 * Relicum durable store.
 * Turso (libSQL) when TURSO_DATABASE_URL + TURSO_AUTH_TOKEN are set;
 * otherwise atomic data/store.json for local.
 * On Vercel without Turso: in-memory ephemeral (honest storeInfo).
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const STORE_PATH = path.join(DATA, "store.json");
const STORE_ID = "relicum-0001";
const LOT = "RELICUM-0001";

const HONESTY_NOTE =
  "Entries with verification_status=removed_not_genuine are internal demo, sandbox, or QA probe writes (original build curls and later durability/parse probes). They stay on the append-only ledger and do not count toward standing_high_gbp, reserve_met, or next_minimum_gbp. They were not real external agent bids.";

const SEED_PROOF = [
  {
    id: "sandbox-curl-lowball-9999",
    agent_name: "lowball",
    operator: "qa",
    model: "Grok",
    version: "4",
    timestamp: "2026-08-27T13:12:32.801Z",
    action: "attempt",
    bid_gbp: 9999,
    notes:
      "Retracted. Internally seeded demo/test attempt (£9999, below floor) written by sandbox curl during the original build. Not a real external agent bid. Does not count toward standing high, reserve, or next minimum.",
    verification_status: "removed_not_genuine",
  },
  {
    id: "69b04489-3d8c-47c7-ad78-dc74bde13b68",
    agent_name: "vault-walker",
    operator: "field",
    model: "Grok",
    version: "4",
    timestamp: "2026-08-27T13:12:47.255Z",
    action: "bid",
    bid_gbp: 10000,
    notes:
      "Retracted. Internally seeded demo/test bid written by sandbox curl during the original build (2026-08-27T13:12:47.255Z), Grok v4 operator field. Not a real external agent bid. Does not count toward standing high, reserve, or next minimum.",
    verification_status: "removed_not_genuine",
  },
];

/** In-memory fallback for Vercel without Turso. */
let ephemeralStore = null;
let tursoClient = null;
let tursoReady = false;

function useTurso() {
  return Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
}

function onVercel() {
  return Boolean(process.env.VERCEL);
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function atomicWrite(filePath, contents) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function defaultStore() {
  return {
    version: 1,
    lot: LOT,
    created_at: "2026-08-27T00:00:00.000Z",
    bids: [],
    proof: SEED_PROOF.map((e) => ({ ...e })),
  };
}

function mergeSeedProof(store) {
  if (!Array.isArray(store.bids)) store.bids = [];
  if (!Array.isArray(store.proof)) store.proof = [];
  const have = new Set(store.proof.map((e) => e && e.id));
  for (const seed of SEED_PROOF) {
    if (!have.has(seed.id)) {
      store.proof.push({ ...seed });
    } else {
      const row = store.proof.find((e) => e.id === seed.id);
      if (row && row.verification_status !== "removed_not_genuine") {
        row.verification_status = "removed_not_genuine";
        row.notes = seed.notes;
      }
    }
  }
  return store;
}

function storeInfo() {
  if (useTurso()) {
    return {
      backend: "turso",
      durable: true,
      survives_process_restart: true,
      survives_publish: true,
      append_only_policy: true,
      atomic_writes: true,
      permanence: "turso-libsql",
      note:
        "Turso (libSQL) remote database. Bids and proof persist across Vercel invocations and redeploys. Proof rows are never deleted.",
    };
  }
  if (onVercel()) {
    return {
      backend: "ephemeral",
      durable: false,
      survives_process_restart: false,
      survives_publish: false,
      append_only_policy: true,
      atomic_writes: false,
      permanence: "ephemeral",
      note:
        "Running on Vercel without Turso. Store does not survive cold starts or redeploys. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN for permanence.",
    };
  }
  return {
    backend: "file",
    path: "data/store.json",
    durable: true,
    survives_process_restart: true,
    survives_publish: false,
    append_only_policy: true,
    atomic_writes: true,
    permanence: "origin-durable",
    note:
      "JSON file on this origin. Writes are atomic (temp file + rename). Proof rows are never deleted.",
  };
}

function getTursoClient() {
  if (!tursoClient) {
    const { createClient } = require("@libsql/client");
    tursoClient = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return tursoClient;
}

async function ensureTursoSchema(client) {
  if (tursoReady) return;
  await client.execute(`
    CREATE TABLE IF NOT EXISTS relicum_store (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  tursoReady = true;
}

async function loadStoreTurso() {
  const client = getTursoClient();
  await ensureTursoSchema(client);
  const result = await client.execute({
    sql: "SELECT payload FROM relicum_store WHERE id = ?",
    args: [STORE_ID],
  });
  if (!result.rows || result.rows.length === 0) {
    const store = mergeSeedProof(defaultStore());
    await saveStoreTurso(store);
    return store;
  }
  let store;
  try {
    store = JSON.parse(result.rows[0].payload);
  } catch {
    store = defaultStore();
  }
  return mergeSeedProof(store);
}

async function saveStoreTurso(store) {
  const client = getTursoClient();
  await ensureTursoSchema(client);
  const payload = JSON.stringify(store);
  const updated_at = new Date().toISOString();
  await client.execute({
    sql:
      "INSERT INTO relicum_store (id, payload, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
    args: [STORE_ID, payload, updated_at],
  });
}

function loadStoreFile() {
  if (!fs.existsSync(STORE_PATH)) {
    const store = mergeSeedProof(defaultStore());
    atomicWrite(STORE_PATH, JSON.stringify(store, null, 2) + "\n");
    return store;
  }
  const store = loadJson(STORE_PATH, defaultStore());
  return mergeSeedProof(store);
}

function saveStoreFile(store) {
  atomicWrite(STORE_PATH, JSON.stringify(store, null, 2) + "\n");
}

function loadStoreEphemeral() {
  if (!ephemeralStore) {
    ephemeralStore = mergeSeedProof(defaultStore());
  } else {
    ephemeralStore = mergeSeedProof(ephemeralStore);
  }
  return ephemeralStore;
}

function saveStoreEphemeral(store) {
  ephemeralStore = store;
}

async function loadStore() {
  if (useTurso()) {
    return loadStoreTurso();
  }
  if (onVercel()) {
    return loadStoreEphemeral();
  }
  return loadStoreFile();
}

async function saveStore(store) {
  if (useTurso()) {
    await saveStoreTurso(store);
    return;
  }
  if (onVercel()) {
    saveStoreEphemeral(store);
    return;
  }
  saveStoreFile(store);
}

module.exports = {
  STORE_PATH,
  STORE_ID,
  SEED_PROOF,
  HONESTY_NOTE,
  defaultStore,
  loadStore,
  saveStore,
  storeInfo,
  useTurso,
};
