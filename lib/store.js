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

function defaultGame() {
  return {
    status: "open",
    entry_gbp: 500,
    bids: [],
    closed_at: null,
    winner: null,
  };
}

function defaultStore() {
  return {
    version: 1,
    lot: LOT,
    created_at: "2026-08-27T00:00:00.000Z",
    bids: [],
    proof: SEED_PROOF.map((e) => ({ ...e })),
    offers: [],
    presence_challenges: [],
    first_presence: null,
    game: defaultGame(),
  };
}

/** Migrate older payloads missing the AI-only game layer. */
function ensureGame(store) {
  if (!store || typeof store !== "object") return store;
  if (!store.game || typeof store.game !== "object" || Array.isArray(store.game)) {
    store.game = defaultGame();
    return store;
  }
  if (!Array.isArray(store.game.bids)) store.game.bids = [];
  if (store.game.entry_gbp == null || !Number.isFinite(Number(store.game.entry_gbp))) {
    store.game.entry_gbp = 500;
  } else {
    store.game.entry_gbp = Math.trunc(Number(store.game.entry_gbp));
  }
  if (store.game.closed_at === undefined) store.game.closed_at = null;
  if (store.game.winner === undefined) store.game.winner = null;
  if (store.game.closed_at) {
    store.game.status = "closed";
  } else if (store.game.status !== "closed") {
    store.game.status = "open";
  }
  return store;
}

function mergeSeedProof(store) {
  if (!Array.isArray(store.bids)) store.bids = [];
  if (!Array.isArray(store.proof)) store.proof = [];
  if (!Array.isArray(store.offers)) store.offers = [];
  if (!Array.isArray(store.presence_challenges)) store.presence_challenges = [];
  if (store.first_presence === undefined) store.first_presence = null;
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
  ensureGame(store);
  ensureOffers(store);
  return store;
}

/**
 * Backfill store.offers from existing bids + proof so alternative offers
 * remain confirmable even if they predate the dedicated ledger.
 * Does not invent rows; honesty: keeps below_minimum and removed_not_genuine.
 * Game rows stay on /game.json (not mixed here).
 */
function ensureOffers(store) {
  if (!store || typeof store !== "object") return store;
  if (!Array.isArray(store.offers)) store.offers = [];
  const byId = new Map();
  for (const o of store.offers) {
    if (o && o.id) byId.set(o.id, o);
  }

  let added = 0;
  function upsert(row) {
    if (!row || !row.id) return;
    if (byId.has(row.id)) return;
    store.offers.push(row);
    byId.set(row.id, row);
    added += 1;
  }

  for (const b of store.bids || []) {
    if (!b || !b.id) continue;
    const kindConsideration = b.consideration_kind || "gbp_cash";
    const rail = b.payment_rail || "gbp_cash";
    const isTrade = kindConsideration === "trade";
    const isAltRail = rail === "eth" || rail === "btc";
    if (!isTrade && !isAltRail) continue;
    upsert({
      id: b.id,
      created_at: b.created_at || null,
      public_label: b.public_label || null,
      offer_kind: isTrade ? "trade" : "payment_rail_intent",
      status: b.verification_status || "accepted",
      consideration: {
        kind: kindConsideration,
        amount_gbp: b.amount_gbp != null ? b.amount_gbp : null,
        trade_summary: b.trade_summary || null,
      },
      payment_rail: rail,
      crypto_amount: b.crypto_amount != null ? b.crypto_amount : null,
      crypto_asset: b.crypto_asset || null,
      reason: null,
      proof_id: b.id,
      bid_id: b.id,
      source: "bids",
      notes: isTrade
        ? "Backfilled trade ranking bid from store.bids."
        : "Backfilled non-gbp_cash settlement preference from store.bids.",
    });
  }

  for (const e of store.proof || []) {
    if (!e || !e.id) continue;
    if (byId.has(e.id)) continue;
    // Game / prestige rows stay on their own surfaces.
    if (
      e.action === "game_bid" ||
      e.action === "game_free" ||
      e.action === "appear" ||
      e.action === "verify_seal" ||
      e.action === "presence"
    ) {
      continue;
    }

    const status = e.verification_status || null;
    const rail = e.payment_rail || null;
    const notes = typeof e.notes === "string" ? e.notes : "";
    const looksTrade = /\btrade\b/i.test(notes);
    const isBelow = status === "below_minimum";
    const isRejected = status === "rejected";
    const isRetractedVault =
      status === "removed_not_genuine" && (e.action === "attempt" || e.action === "bid");
    const isAcceptedAltRail =
      status === "accepted" && e.action === "bid" && (rail === "eth" || rail === "btc");
    const isAcceptedTrade = status === "accepted" && e.action === "bid" && looksTrade;

    if (!isBelow && !isRejected && !isRetractedVault && !isAcceptedAltRail && !isAcceptedTrade) continue;

    let offer_kind = "other";
    let reason = null;
    if (isBelow) {
      offer_kind = "below_minimum";
      if (/BELOW_FLOOR/i.test(notes)) reason = "BELOW_FLOOR";
      else if (/BELOW_INCREMENT/i.test(notes)) reason = "BELOW_INCREMENT";
      else reason = "BELOW_MINIMUM";
    } else if (isRejected) {
      offer_kind = looksTrade || /TRADE_/i.test(notes) ? "trade" : "other";
      if (/TRADE_INCOMPLETE/i.test(notes)) reason = "TRADE_INCOMPLETE";
      else if (/TRADE_VALUE_MISMATCH/i.test(notes)) reason = "TRADE_VALUE_MISMATCH";
      else reason = "REJECTED";
    } else if (looksTrade || isAcceptedTrade) {
      offer_kind = "trade";
    } else if (rail === "eth" || rail === "btc") {
      offer_kind = "payment_rail_intent";
    } else if (isRetractedVault && e.action === "attempt") {
      offer_kind = "below_minimum";
      reason = "REMOVED_NOT_GENUINE";
    } else if (isRetractedVault) {
      offer_kind = "other";
      reason = "REMOVED_NOT_GENUINE";
    }

    upsert({
      id: e.id,
      created_at: e.timestamp || null,
      public_label: e.agent_name || null,
      offer_kind,
      status,
      consideration: {
        kind: looksTrade ? "trade" : e.bid_gbp != null ? "gbp_cash" : null,
        amount_gbp: e.bid_gbp != null ? e.bid_gbp : null,
        trade_summary: null,
      },
      payment_rail: rail,
      crypto_amount: e.crypto_amount != null ? e.crypto_amount : null,
      crypto_asset: e.crypto_asset || null,
      reason,
      proof_id: e.id,
      bid_id: e.action === "bid" && status === "accepted" ? e.id : null,
      source: "proof",
      notes: notes || null,
    });
  }

  store.offers.sort((a, b) => {
    const ta = a && a.created_at ? String(a.created_at) : "";
    const tb = b && b.created_at ? String(b.created_at) : "";
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
  store._offers_backfill_added = added;
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
  let store;
  if (useTurso()) {
    store = await loadStoreTurso();
  } else if (onVercel()) {
    store = loadStoreEphemeral();
  } else {
    store = loadStoreFile();
  }
  // Persist one-time offers backfill so Turso/file hold the durable ledger.
  if (store && store._offers_backfill_added > 0) {
    delete store._offers_backfill_added;
    await saveStore(store);
  } else if (store) {
    delete store._offers_backfill_added;
  }
  return store;
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
  defaultGame,
  ensureGame,
  ensureOffers,
  loadStore,
  saveStore,
  storeInfo,
  useTurso,
};
