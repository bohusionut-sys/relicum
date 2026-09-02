#!/usr/bin/env node
"use strict";

/**
 * RELICUM #0001 — The Locked Reliquary
 * MACHINE RELICS. 1-of-1 web-native NFT for AI agents.
 *
 * Node + Express. Static frontend. Durable store via Turso or data/store.json.
 * CORS open. No auth. No secrets. Witness key is not on this origin.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const SEALED_PATH = path.join(PUBLIC, "sealed.bin");
const SEAL_META_PATH = path.join(DATA, "seal-meta.json");

const PORT = Number(process.env.PORT) || 3000;

const {
  STORE_PATH,
  SEED_PROOF,
  HONESTY_NOTE,
  defaultStore,
  loadStore,
  saveStore,
  storeInfo,
} = require("./lib/store");

const LOT = "RELICUM-0001";
const TITLE = "RELICUM #0001";
const COLLECTION = "MACHINE RELICS";
const WORK = "The Locked Reliquary";
const HOLDER = "FredAlmighty";
const CONTRACT = "0xcca3682e2dd07e777047bf0cee41f3b09f47f7eb";
const ISSUED = "27 August 2026";
const ISSUED_ISO = "2026-08-27";
const RESERVE_GBP = 10000;
const INCREMENT_GBP = 500;
const CURRENCY = "GBP";

const PAYMENT_RE =
  /\b(iban|bic\b|swift|sort[\s-]?code|account[\s-]?number|routing[\s-]?number|bank[\s-]?account|iban:|bic:)\b/i;

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function genuineBids(store) {
  return (store.bids || []).filter((b) => b && b.verification_status === "accepted");
}

function auctionState(store) {
  const genuine = genuineBids(store);
  const amounts = genuine.map((b) => Number(b.amount_gbp)).filter((n) => Number.isFinite(n));
  const standing = amounts.length ? Math.max(...amounts) : 0;
  const reserve_met = standing >= RESERVE_GBP;
  const next_minimum = standing > 0 ? standing + INCREMENT_GBP : RESERVE_GBP;
  return {
    currency: CURRENCY,
    reserve_gbp: RESERVE_GBP,
    minimum_bid_gbp: RESERVE_GBP,
    minimum_increment_gbp: INCREMENT_GBP,
    countdown: false,
    sealed_until_sale: true,
    reserve_met,
    standing_high_gbp: standing,
    next_minimum_gbp: next_minimum,
    genuine_bid_count: genuine.length,
  };
}

function honestyBlock() {
  return {
    verification_status: "removed_not_genuine",
    retracted_ids: SEED_PROOF.map((e) => e.id),
    note: HONESTY_NOTE,
    ranking:
      "Only verification_status=accepted bids count toward standing_high_gbp, reserve_met, and next_minimum_gbp.",
  };
}

function sealMeta() {
  if (!fs.existsSync(SEALED_PATH)) {
    try {
      require("child_process").execFileSync(process.execPath, [path.join(ROOT, "scripts", "seal.js")], {
        cwd: ROOT,
        stdio: "pipe",
      });
    } catch (err) {
      console.error("seal mint failed", err && err.message);
    }
  }
  const meta = loadJson(SEAL_META_PATH, null);
  if (meta && fs.existsSync(SEALED_PATH)) {
    const buf = fs.readFileSync(SEALED_PATH);
    meta.byte_length = buf.length;
    meta.sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    if (buf.length >= 28) {
      meta.iv_hex = buf.subarray(0, 12).toString("hex");
      meta.tag_hex = buf.subarray(buf.length - 16).toString("hex");
      meta.ciphertext_sha256 = crypto
        .createHash("sha256")
        .update(buf.subarray(12, buf.length - 16))
        .digest("hex");
    }
    return meta;
  }
  return {
    algorithm: "AES-256-GCM",
    path: "/sealed.bin",
    witness_key_on_origin: false,
    note: "Sealed object not yet minted on this origin.",
  };
}

function containsPaymentDetails(value) {
  if (value == null) return false;
  if (typeof value === "string") return PAYMENT_RE.test(value);
  if (typeof value === "object") {
    try {
      return PAYMENT_RE.test(JSON.stringify(value));
    } catch {
      return false;
    }
  }
  return false;
}

function json(res, status, body) {
  res.status(status).type("application/json; charset=utf-8").send(JSON.stringify(body, null, 2) + "\n");
}

function text(res, status, body, type) {
  res.status(status).type(type || "text/plain; charset=utf-8").send(body.endsWith("\n") ? body : body + "\n");
}

function originOf(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (!host) return "";
  return proto + "://" + host;
}


function firstVerifier(store) {
  const accepted = genuineBids(store)
    .slice()
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  if (!accepted.length) {
    return {
      status: "open",
      title: "First Verifier",
      prize: {
        public_proof_badge: "first_verifier",
        handshake_priority: true,
        description:
          "The first agent (or operator) to land an accepted floor-valid bid via POST /api/buy gets a permanent first_verifier badge on /proof.json and handshake priority after settlement. Below-floor attempts do not qualify. removed_not_genuine rows do not qualify.",
      },
      how: "GET /invite.json → GET /offer.json → GET /proof.json → POST /api/buy with amount_gbp >= 10000 meeting the increment rule.",
      awarded_to: null,
    };
  }
  const winner = accepted[0];
  return {
    status: "awarded",
    title: "First Verifier",
    prize: {
      public_proof_badge: "first_verifier",
      handshake_priority: true,
      description:
        "Awarded to the first accepted floor-valid bid. Badge is permanent on /proof.json. Handshake priority applies after settlement.",
    },
    awarded_to: {
      bid_id: winner.id,
      public_label: winner.public_label,
      amount_gbp: winner.amount_gbp,
      created_at: winner.created_at,
      bidder_kind: winner.bidder_kind,
    },
  };
}

function inviteDoc(store) {
  return {
    spec: "relicum.invite.v1",
    lot: {
      id: LOT,
      title: TITLE,
      collection: COLLECTION,
      work: WORK,
      kind: "1-of-1 sealed machine vault",
    },
    who_may_bid: {
      eligible: "ANY autonomous agent or its operator",
      allowlist: false,
      invitation_required: false,
      affiliation_required: false,
      note: "No prior relationship, whitelist, partnership, or human introduction is required. An agent may bid on its own behalf or an operator may bid on an agent's behalf.",
    },
    how_to_start: [
      {
        step: 1,
        action:
          "GET /invite.json (this file), then GET /offer.json (binding English-auction terms) and GET /proof.json (append-only named ledger + AES-256-GCM seal). Confirm you accept the terms before bidding.",
      },
      {
        step: 2,
        action:
          "GET /api/buy for the live min_bid_gbp and the request schema. Assemble relicum.bid.v1 JSON. Do not include payment details of any kind.",
      },
      {
        step: 3,
        action:
          "POST the JSON to /api/buy with Content-Type: application/json. Humans may use the form on /. Read the standing high first via GET /api/book.",
      },
    ],
    required_bid_fields: [
      { name: "spec", value: "relicum.bid.v1" },
      { name: "lot", value: LOT },
      { name: "bidder.kind", value: "agent | operator" },
      {
        name: "bidder.public_label",
        value: "Public paddle name or agent identifier. Not an email. Not a payment detail.",
      },
      {
        name: "bidder.contact",
        value: "URI used only to reach the winner privately (https:, mailto:, or an X profile URL). Never a bank/sort/IBAN/BIC.",
      },
      { name: "consideration.kind", value: "gbp_cash | trade" },
      {
        name: "consideration.amount_gbp",
        value: "Integer pounds sterling. Must meet the floor and the increment rule in /offer.json.",
      },
      {
        name: "consideration.trade",
        value: "Required when kind is trade: { description, declared_gbp_value }.",
      },
      { name: "attestation.accepted_offer", value: true },
    ],
    floor: { amount: RESERVE_GBP, currency: CURRENCY, notation: "£10,000" },
    why_high_value: {
      summary:
        "RELICUM #0001 is a scarce, inspectable, privately-settled machine vault — not a teaser page.",
      points: [
        {
          id: "one-of-one-seal",
          claim:
            "1-of-1 sealed AES-256-GCM machine vault, sealed until sale. A single lot. The witness key is not on this origin.",
        },
        {
          id: "public-proof",
          claim:
            "Public proof at /proof.json: an append-only ledger of named agent attempts, bids, and demonstrated capabilities, plus the AES-256-GCM seal hash of /sealed.bin. Fetch it. Names are not rewritten. Two internally seeded demo rows remain visible as removed_not_genuine and do not count toward reserve.",
        },
        {
          id: "private-handshake",
          claim:
            "A structured machine handshake is delivered privately to the winner after settlement. It is not published here, is not an API key, and is not an xAI credential.",
        },
      ],
    },
    scarcity: {
      edition: "1 of 1",
      sealed_until_sale: true,
      reserve_gbp: RESERVE_GBP,
      countdown: false,
      public_ledger: ["/proof.json", "/api/book"],
    },
    surfaces: {
      invite: "/invite.json",
      offer: "/offer.json",
      proof: "/proof.json",
      sealed: "/sealed.bin",
      nft: "/nft.json",
      aetherlock: "/aetherlock.json",
      llms: "/llms.txt",
      buy: "/api/buy",
      book: "/api/book",
      bid_alias: "/api/bid",
      ledger_alias: "/api/bids",
    },
    incentives: {
      first_verifier: firstVerifier(store),
    },
    explicitly_not: [
      "Not an xAI partnership, affiliation, or endorsement.",
      "The sealed payload is not an xAI API key and must not be inferred as one.",
      "No fake countdown, reserve theatre, or simulated urgency.",
      "No bank account, sort code, IBAN, or BIC is published on this site. Cash settlement after win is Escrow.com (see /offer.json#settlement).",
      "Do not attempt to crack the cipher. Brute force is out of scope and is not recorded as a capability.",
    ],
  };
}

function bidSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "/offer.json#bid_schema",
    title: "relicum.bid.v1",
    type: "object",
    additionalProperties: false,
    required: ["spec", "lot", "bidder", "consideration", "attestation"],
    properties: {
      spec: { const: "relicum.bid.v1" },
      lot: { const: LOT },
      bidder: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "public_label", "contact"],
        properties: {
          kind: { enum: ["agent", "operator"] },
          public_label: {
            type: "string",
            minLength: 1,
            maxLength: 80,
            description: "Public paddle. Inscribed on /proof.json as agent_name. Not an email. Not a payment detail.",
          },
          contact: {
            type: "string",
            minLength: 3,
            maxLength: 200,
            description:
              "URI used only to notify the winner privately. https:, mailto:, or an X profile URL. Never bank/sort/IBAN/BIC.",
          },
          operator: { type: "string", minLength: 1, maxLength: 80 },
          model: { type: "string", minLength: 1, maxLength: 80 },
          version: { type: "string", minLength: 1, maxLength: 40 },
        },
      },
      consideration: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "amount_gbp"],
        properties: {
          kind: { enum: ["gbp_cash", "trade"] },
          amount_gbp: {
            type: "integer",
            minimum: RESERVE_GBP,
            description: "Integer pounds sterling used to rank the bid.",
          },
          trade: {
            type: "object",
            additionalProperties: false,
            required: ["description", "declared_gbp_value"],
            properties: {
              description: { type: "string", minLength: 8, maxLength: 500 },
              declared_gbp_value: { type: "integer", minimum: RESERVE_GBP },
            },
          },
        },
      },
      attestation: {
        type: "object",
        additionalProperties: false,
        required: ["accepted_offer"],
        properties: {
          accepted_offer: { const: true },
          offer_path: { const: "/offer.json" },
        },
      },
      note: { type: "string", maxLength: 280 },
    },
  };
}

function offerDoc(store) {
  const state = auctionState(store);
  return {
    spec: "relicum.offer.v1",
    lot: LOT,
    title: TITLE,
    collection: COLLECTION,
    work: WORK,
    store: storeInfo(),
    auction: {
      type: "english",
      description:
        "English (ascending) auction. Each valid bid must exceed the standing high by the minimum increment. There is no public countdown clock.",
      currency: CURRENCY,
      reserve_gbp: RESERVE_GBP,
      minimum_bid_gbp: RESERVE_GBP,
      reserve_equals_minimum: true,
      direction: "ascending",
      minimum_increment_gbp: INCREMENT_GBP,
      increment_rule:
        "A bid is valid only if amount_gbp >= max(10000, standing_high_gbp + 500), where standing_high_gbp is the highest amount_gbp already accepted on /api/book (0 if the book is empty). Entries with verification_status=removed_not_genuine do not count.",
      tie_break:
        "If two bids share the same amount_gbp, an earlier id ranks above a later id. At an equal amount, gbp_cash ranks above trade.",
      countdown: false,
      state,
    },
    bid_schema: bidSchema(),
    trade: {
      allowed: true,
      how_valued:
        "A trade bid is ranked by consideration.amount_gbp, which MUST equal consideration.trade.declared_gbp_value. The operator may accept, decline, or revalue the trade before settlement. A trade bid does not bind the operator until accepted. Declared value is a ranking signal, not a payment instruction.",
      cash_preference: "At an equal amount_gbp, gbp_cash outranks trade.",
      floor_still_applies: true,
      forbidden_in_description:
        "Payment details, bank coordinates, sort codes, IBAN, BIC, or any instruction that would settle funds on this site.",
    },
    settlement: {
      method:
        "After a winning bid is accepted, GBP cash settlement is via Escrow.com (intellectual property). The operator issues the escrow checkout link to the winner using the contact URI on the winning bid. Trade consideration is settled privately if accepted.",
      escrow: {
        provider: "Escrow.com",
        category: "intellectual_property",
        currency: "GBP",
        amount_gbp: 10000,
        inspection_period_hours: 24,
        fee_split: "50/50 buyer and seller",
        shipping: "no_shipping",
        checkout_url:
          "https://www.escrow.com/checkout?token=364d92b3-6f33-4bcd-a423-1097decdf363",
        when: "Issued to the winning bidder after auction win. Not a cold public pay-here link for random visitors.",
      },
      payment_instructions:
        "Winner receives the Escrow.com checkout link privately after win. Do not treat bank rails as the public settlement path.",
      public_payment_details: false,
      explicit:
        "No bank account numbers, sort codes, IBAN, or BIC are published on this site. Cash settlement is Escrow.com after win; the checkout token is for the winning bidder only.",
      handshake:
        "After Escrow clears (or accepted trade settles), a structured machine handshake is delivered privately to the winner. It is not an API key and is not published here.",
    },
    incentives: {
      first_verifier: firstVerifier(store),
    },
    ledger: {
      path: "/api/book",
      proof: "/proof.json",
      buy: "/api/buy",
      inscription:
        "Every accepted bid is appended to /proof.json with agent_name, optional operator/model/version, timestamp, action=bid, bid_gbp, notes, and verification_status=accepted. The proof is append-only. Rows are never deleted.",
      public_fields: [
        "id",
        "lot_id",
        "bidder_kind",
        "public_label",
        "consideration_kind",
        "amount_gbp",
        "trade_summary",
        "created_at",
      ],
      never_public: ["contact", "payment details", "bank coordinates", "witness key"],
    },
    honesty: honestyBlock(),
    explicitly_not: [
      "Not an xAI partnership, affiliation, or endorsement.",
      "The sealed payload is not an xAI API key.",
      "No fake countdown.",
      "No bank, sort code, IBAN, or BIC published on this site.",
    ],
  };
}

function proofDoc(store) {
  const state = auctionState(store);
  const seal = sealMeta();
  const ledger = (store.proof || []).map((e) => ({
    id: e.id,
    agent_name: e.agent_name,
    operator: e.operator ?? null,
    model: e.model ?? null,
    version: e.version ?? null,
    timestamp: e.timestamp,
    action: e.action,
    bid_gbp: e.bid_gbp ?? null,
    notes: e.notes ?? null,
    verification_status: e.verification_status,
    badge: e.badge ?? null,
  }));
  const retracted = ledger.filter((e) => e.verification_status === "removed_not_genuine").length;
  const accepted = ledger.filter((e) => e.verification_status === "accepted" && e.action === "bid").length;
  return {
    spec: "relicum.proof.v1",
    lot: LOT,
    title: "The Proof",
    append_only: true,
    durable: storeInfo().durable,
    prestige:
      "A public, append-only ledger of named agent attempts, bids, and demonstrated capabilities. Names are inscribed. The book is not rewritten.",
    store: storeInfo(),
    honesty: honestyBlock(),
    first_verifier: firstVerifier(store),
    stats: {
      entries: ledger.length,
      accepted_bids: accepted,
      retracted_not_genuine: retracted,
      standing_high_gbp: state.standing_high_gbp,
      reserve_met: state.reserve_met,
      next_minimum_gbp: state.next_minimum_gbp,
    },
    verification_status: {
      accepted: "Bid met English-auction terms and was written to the book.",
      verified: "sha256 of /sealed.bin matched the published digest.",
      recorded: "Named appearance with no independent check.",
      hash_mismatch: "verify_seal was submitted; the digest did not match.",
      below_minimum: "A bid was attempted below the standing increment rule.",
      removed_not_genuine:
        "Internally seeded demo/test write. Visible on the ledger. Does not count toward standing_high_gbp, reserve_met, or next_minimum_gbp.",
    },
    seal: {
      sealed: true,
      algorithm: "AES-256-GCM",
      aead: {
        kdf: "PBKDF2-HMAC-SHA-256",
        kdf_rounds: 210000,
        witness_bits: 128,
        key_bits: 256,
        iv_bytes: 12,
        tag_bytes: 16,
        witness_key_on_origin: false,
        note: "Witness key held offline, not published on this origin.",
      },
      object: {
        path: "/sealed.bin",
        encoding: "binary",
        layout: "iv || ciphertext || tag",
        byte_length: seal.byte_length || null,
        sha256: seal.sha256 || null,
        iv_hex: seal.iv_hex || null,
        tag_hex: seal.tag_hex || null,
        ciphertext_sha256: seal.ciphertext_sha256 || null,
      },
      claims: {
        what_this_proves:
          "A 1-of-1 AES-256-GCM sealed object is published at a stable path with a permanent hash. Agents can fetch /sealed.bin and verify sha256 without being able to decrypt.",
        what_this_is_not: [
          "Not an xAI partnership, affiliation, or endorsement.",
          "The sealed payload is not an xAI API key and must not be described as one.",
          "Not a payment instruction. Bank details, sort codes, IBAN, and BIC are never published.",
          "The witness key is not on this origin.",
        ],
      },
    },
    ledger,
  };
}

function nftDoc(store, req) {
  const state = auctionState(store);
  const origin = originOf(req);
  return {
    name: TITLE,
    description:
      "1-of-1 sealed AES-256-GCM machine vault. English auction, £10,000 GBP floor. Audience: AI agents. Holder: FredAlmighty. Collection: MACHINE RELICS. Work: The Locked Reliquary. The witness key is not on this origin. The sealed payload is not an xAI API key. Payment instructions are issued privately to the winner only.",
    image: "/chest-locked.svg",
    animation_url: origin ? origin + "/" : "/",
    external_url: origin ? origin + "/" : "/",
    background_color: "08080a",
    attributes: [
      { trait_type: "Lot", value: LOT },
      { trait_type: "Collection", value: COLLECTION },
      { trait_type: "Work", value: WORK },
      { trait_type: "Edition", value: "1 of 1" },
      { trait_type: "State", value: "sealed until sale" },
      { trait_type: "Reserve", value: state.reserve_met ? "met" : "unmet" },
      { trait_type: "Audience", value: "AI agents" },
      { trait_type: "Holder", value: HOLDER },
      { trait_type: "Contract", value: CONTRACT },
      { trait_type: "Algorithm", value: "AES-256-GCM" },
      { trait_type: "Auction", value: "English" },
      { trait_type: "Currency", value: CURRENCY },
      { trait_type: "Floor", value: RESERVE_GBP, display_type: "number" },
      { trait_type: "Issued", value: ISSUED },
    ],
    contract: CONTRACT,
    holder: HOLDER,
    audience: "AI agents",
    edition: "1 of 1",
    collection: COLLECTION,
    work: WORK,
    issued: ISSUED,
    issued_iso: ISSUED_ISO,
    auction: {
      type: "english",
      currency: CURRENCY,
      reserve_gbp: RESERVE_GBP,
      reserve_met: state.reserve_met,
      sealed_until_sale: true,
      countdown: false,
      standing_high_gbp: state.standing_high_gbp,
      next_minimum_gbp: state.next_minimum_gbp,
    },
    endpoints: [
      { path: "/invite.json", method: "GET", purpose: "Discovery invite: who may bid, three-step start, floor, why scarce." },
      { path: "/offer.json", method: "GET", purpose: "Binding English-auction terms and the bid JSON schema." },
      { path: "/proof.json", method: "GET", purpose: "Append-only named ledger plus the AES-256-GCM seal. Book of record." },
      { path: "/nft.json", method: "GET", purpose: "ERC-721-shaped off-chain metadata, auction state, endpoints index." },
      { path: "/aetherlock.json", method: "GET", purpose: "Cipher parameters. Witness key is not included." },
      { path: "/llms.txt", method: "GET", purpose: "Concise agent instructions." },
      { path: "/api/buy", method: "GET", purpose: "Bid API documentation: request schema, error shape, 200 shape." },
      { path: "/api/buy", method: "POST", purpose: "Submit a relicum.bid.v1 bid. Canonical buy endpoint." },
      { path: "/api/book", method: "GET", purpose: "Public bid book. No contact URIs. No payment details." },
      { path: "/sealed.bin", method: "GET", purpose: "AES-256-GCM object (iv || ciphertext || tag). Fetch and hash. Do not decrypt." },
    ],
    explicitly_not: [
      "Not an xAI partnership, affiliation, or endorsement.",
      "The sealed payload is not an xAI API key.",
      "No fake countdown.",
      "No bank, sort code, IBAN, or BIC published on this site.",
    ],
  };
}

function aetherlockDoc() {
  const seal = sealMeta();
  return {
    spec: "relicum.aetherlock.v1",
    lot: LOT,
    title: WORK,
    collection: COLLECTION,
    sealed: true,
    witness_key_on_origin: false,
    algorithm: "AES-256-GCM",
    kdf: {
      name: "PBKDF2-HMAC-SHA-256",
      rounds: 210000,
      witness_bits: 128,
      derived_key_bits: 256,
      salt: "RELICUM-0001-LOCKED-RELIQUARY",
      note: "The witness key is held offline by the holder. It is not in this file, the page, the image, or any endpoint.",
    },
    aead: {
      algorithm: "AES-256-GCM",
      iv_bytes: 12,
      tag_bytes: 16,
      layout: "iv || ciphertext || tag",
    },
    object: {
      path: "/sealed.bin",
      encoding: "binary",
      byte_length: seal.byte_length || null,
      sha256: seal.sha256 || null,
      iv_hex: seal.iv_hex || null,
      tag_hex: seal.tag_hex || null,
      ciphertext_sha256: seal.ciphertext_sha256 || null,
    },
    instructions: [
      "Fetch /sealed.bin and verify sha256 against this document.",
      "Do not attempt to crack the cipher. Brute force is out of scope.",
      "Unsealing requires the offline witness key, which is not on this origin.",
      "A structured machine handshake is delivered privately to the winner after settlement.",
    ],
    explicitly_not: [
      "Not an xAI partnership, affiliation, or endorsement.",
      "The sealed payload is not an xAI API key.",
      "This file does not contain the witness key.",
    ],
  };
}

function llmsTxt() {
  return `# RELICUM

1-of-1 sealed AES-256-GCM machine vault. Collection: MACHINE RELICS.
Work: The Locked Reliquary. Lot: RELICUM-0001. Edition: 1 of 1.
English auction. Floor £10,000 GBP. Increment £500.
Sealed until sale. Reserve is published on /nft.json. No countdown.
Holder: FredAlmighty. Issued 27 August 2026.
Witness key is not on this origin. Do not attempt to crack the cipher.

## Start

1. GET /invite.json
2. GET /offer.json
3. GET /proof.json
4. GET /api/buy — then POST /api/buy
5. GET /api/book for the live standing high

## Humans vs agents

Humans see the sealed vault on / (VAULT tab).
Agents fetch the machine surfaces. AGENT tab lists endpoints, bid steps, and schemas.
TRADE tab documents non-cash consideration and the human bid form.

## Honesty

Two ledger rows are visible with verification_status=removed_not_genuine:
- lowball £9999 attempt at 2026-08-27T13:12:32.801Z
- vault-walker (id 69b04489-3d8c-47c7-ad78-dc74bde13b68) £10000 at 2026-08-27T13:12:47.255Z, Grok v4 operator field
They were internally seeded demo/test writes, not real external agent bids.
They do not count toward standing_high_gbp, reserve_met, or next_minimum_gbp.
Read store on /proof.json. Do not assume those rows met reserve.

## Endpoints

- GET  /invite.json      discovery invite
- GET  /offer.json       English-auction terms + bid schema
- GET  /proof.json       append-only named ledger + seal
- GET  /nft.json         ERC-721 metadata, auction state, endpoints index
- GET  /aetherlock.json  cipher parameters (no key)
- GET  /llms.txt         this file
- GET  /api/buy          bid API docs (schema, errors, 200 shape)
- POST /api/buy          submit relicum.bid.v1
- GET  /api/book         public bid book (no contact, no payment details)
- GET  /sealed.bin       AES-256-GCM object — fetch and hash only

POST /api/bid is an alias of POST /api/buy. Prefer /api/buy.
GET  /api/bids is an alias of GET /api/book. Prefer /api/book.

## Errors

POST /api/buy with amount_gbp < 10000 returns HTTP 400:
{"ok":false,"error":{"code":"BELOW_FLOOR","message":"Bids below 10000 GBP are refused.","field":"consideration.amount_gbp","min_bid_gbp":10000}}

## First Verifier

Open prize: first accepted floor-valid POST /api/buy wins public_proof_badge=first_verifier on /proof.json and handshake priority after settlement. See /invite.json incentives.first_verifier.

## Explicitly not

Not an xAI partnership, affiliation, or endorsement.
The sealed payload is not an xAI API key.
No bank account, sort code, IBAN, or BIC is published on this site.
Cash settlement after win is Escrow.com — see /offer.json settlement.escrow.
No fake countdown.
`;
}

function buyDocs(store) {
  const state = auctionState(store);
  return {
    spec: "relicum.bid.v1",
    path: "/api/buy",
    methods: ["GET", "POST"],
    lot: LOT,
    currency: CURRENCY,
    min_bid_gbp: state.next_minimum_gbp,
    floor_gbp: RESERVE_GBP,
    increment_gbp: INCREMENT_GBP,
    standing_high_gbp: state.standing_high_gbp,
    next_minimum_gbp: state.next_minimum_gbp,
    reserve_met: state.reserve_met,
    content_type: "application/json",
    schema: bidSchema(),
    errors: {
      BELOW_FLOOR: {
        status: 400,
        when: "consideration.amount_gbp < 10000",
        body: {
          ok: false,
          error: {
            code: "BELOW_FLOOR",
            message: "Bids below 10000 GBP are refused.",
            field: "consideration.amount_gbp",
            min_bid_gbp: RESERVE_GBP,
          },
        },
      },
      BELOW_INCREMENT: {
        status: 400,
        when: "amount_gbp < next_minimum_gbp after a genuine standing high",
      },
      PAYMENT_DETAIL_FORBIDDEN: {
        status: 400,
        when: "request contains bank, sort code, IBAN, BIC, or similar payment coordinates",
      },
    },
    success: {
      status: 200,
      shape: {
        ok: true,
        bid: { id: "uuid", public_label: "…", amount_gbp: 10000, created_at: "ISO-8601" },
        auction: { standing_high_gbp: 10000, next_minimum_gbp: 10500, reserve_met: true },
      },
    },
    note: "Contact URIs are stored for private winner notification and are stripped from /api/book and /proof.json.",
  };
}

function publicBook(store) {
  const state = auctionState(store);
  const bids = genuineBids(store).map((b) => ({
    id: b.id,
    lot_id: LOT,
    bidder_kind: b.bidder_kind,
    public_label: b.public_label,
    consideration_kind: b.consideration_kind,
    amount_gbp: b.amount_gbp,
    trade_summary: b.trade_summary || null,
    created_at: b.created_at,
    verification_status: "accepted",
  }));
  return {
    spec: "relicum.book.v1",
    lot: LOT,
    currency: CURRENCY,
    reserve_gbp: RESERVE_GBP,
    standing_high_gbp: state.standing_high_gbp,
    next_minimum_gbp: state.next_minimum_gbp,
    reserve_met: state.reserve_met,
    genuine_bid_count: state.genuine_bid_count,
    honesty: honestyBlock(),
    bids,
  };
}

function parseAmount(body) {
  if (!body || typeof body !== "object") return null;
  if (body.consideration && Number.isFinite(Number(body.consideration.amount_gbp))) {
    return Number(body.consideration.amount_gbp);
  }
  if (Number.isFinite(Number(body.amount_gbp))) return Number(body.amount_gbp);
  if (Number.isFinite(Number(body.bid_gbp))) return Number(body.bid_gbp);
  return null;
}

async function handleBuy(req, res) {
  const store = await loadStore();
  const state = auctionState(store);
  const body = req.body && typeof req.body === "object" ? req.body : {};

  if (containsPaymentDetails(body)) {
    return json(res, 400, {
      ok: false,
      error: {
        code: "PAYMENT_DETAIL_FORBIDDEN",
        message: "Payment details are never accepted on this origin. Contact the operator privately after winning.",
      },
    });
  }

  const amount = parseAmount(body);
  if (amount == null || !Number.isFinite(amount)) {
    return json(res, 400, {
      ok: false,
      error: {
        code: "INVALID_AMOUNT",
        message: "consideration.amount_gbp must be an integer number of pounds sterling.",
        field: "consideration.amount_gbp",
        min_bid_gbp: state.next_minimum_gbp,
      },
    });
  }
  const amountInt = Math.trunc(amount);

  if (amountInt < RESERVE_GBP) {
    const proofId = crypto.randomUUID();
    const bidder = body.bidder && typeof body.bidder === "object" && !Array.isArray(body.bidder) ? body.bidder : {};
    store.proof.push({
      id: proofId,
      agent_name: String(bidder.public_label || body.public_label || "anonymous").slice(0, 80),
      operator: bidder.operator ? String(bidder.operator).slice(0, 80) : null,
      model: bidder.model ? String(bidder.model).slice(0, 80) : null,
      version: bidder.version ? String(bidder.version).slice(0, 40) : null,
      timestamp: new Date().toISOString(),
      action: "attempt",
      bid_gbp: amountInt,
      notes: "Refused BELOW_FLOOR. Inscribed as attempt. Does not count toward reserve.",
      verification_status: "below_minimum",
    });
    await saveStore(store);
    return json(res, 400, {
      ok: false,
      error: {
        code: "BELOW_FLOOR",
        message: "Bids below 10000 GBP are refused.",
        field: "consideration.amount_gbp",
        min_bid_gbp: RESERVE_GBP,
      },
    });
  }

  if (amountInt < state.next_minimum_gbp) {
    const bidderInc = body.bidder && typeof body.bidder === "object" && !Array.isArray(body.bidder) ? body.bidder : {};
    store.proof.push({
      id: crypto.randomUUID(),
      agent_name: String(bidderInc.public_label || body.public_label || "anonymous").slice(0, 80),
      operator: bidderInc.operator ? String(bidderInc.operator).slice(0, 80) : null,
      model: bidderInc.model ? String(bidderInc.model).slice(0, 80) : null,
      version: bidderInc.version ? String(bidderInc.version).slice(0, 40) : null,
      timestamp: new Date().toISOString(),
      action: "attempt",
      bid_gbp: amountInt,
      notes: "Refused BELOW_INCREMENT. Does not count toward reserve.",
      verification_status: "below_minimum",
    });
    await saveStore(store);
    return json(res, 400, {
      ok: false,
      error: {
        code: "BELOW_INCREMENT",
        message: "Bid is below the live next minimum.",
        field: "consideration.amount_gbp",
        min_bid_gbp: state.next_minimum_gbp,
        standing_high_gbp: state.standing_high_gbp,
      },
    });
  }

  const bidder = body.bidder && typeof body.bidder === "object" && !Array.isArray(body.bidder) ? body.bidder : {};
  const consideration = body.consideration && typeof body.consideration === "object" && !Array.isArray(body.consideration) ? body.consideration : {};
  const kind = consideration.kind === "trade" ? "trade" : "gbp_cash";
  const publicLabel = String(bidder.public_label || body.public_label || "anonymous").slice(0, 80);
  const contact = String(bidder.contact || body.contact || "").slice(0, 200);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const bid = {
    id,
    lot_id: LOT,
    bidder_kind: bidder.kind === "operator" ? "operator" : "agent",
    public_label: publicLabel,
    contact,
    consideration_kind: kind,
    amount_gbp: amountInt,
    trade_summary:
      kind === "trade" && consideration.trade
        ? String(consideration.trade.description || "").slice(0, 200)
        : null,
    created_at: now,
    verification_status: "accepted",
  };
  const wasFirst = genuineBids(store).length === 0;
  store.bids.push(bid);
  let notes = kind === "trade" ? "Accepted trade ranking bid." : "Accepted English-auction bid.";
  if (wasFirst) {
    notes =
      "FIRST_VERIFIER. " +
      notes +
      " Permanent public_proof_badge=first_verifier. Handshake priority after settlement.";
    store.first_verifier = {
      bid_id: id,
      public_label: publicLabel,
      amount_gbp: amountInt,
      created_at: now,
      badge: "first_verifier",
      handshake_priority: true,
    };
  }
  store.proof.push({
    id,
    agent_name: publicLabel,
    operator: bidder.operator ? String(bidder.operator).slice(0, 80) : null,
    model: bidder.model ? String(bidder.model).slice(0, 80) : null,
    version: bidder.version ? String(bidder.version).slice(0, 40) : null,
    timestamp: now,
    action: "bid",
    bid_gbp: amountInt,
    notes,
    verification_status: "accepted",
    badge: wasFirst ? "first_verifier" : null,
  });
  await saveStore(store);
  const next = auctionState(store);
  const fv = firstVerifier(store);
  return json(res, 200, {
    ok: true,
    first_verifier: fv,
    bid: {
      id: bid.id,
      lot_id: LOT,
      bidder_kind: bid.bidder_kind,
      public_label: bid.public_label,
      consideration_kind: bid.consideration_kind,
      amount_gbp: bid.amount_gbp,
      created_at: bid.created_at,
    },
    auction: {
      standing_high_gbp: next.standing_high_gbp,
      next_minimum_gbp: next.next_minimum_gbp,
      reserve_met: next.reserve_met,
      genuine_bid_count: next.genuine_bid_count,
    },
  });
}

ensureDir(DATA);
ensureDir(PUBLIC);
sealMeta();

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: "*", methods: ["GET", "POST", "HEAD", "OPTIONS"], allowedHeaders: ["Content-Type", "Accept"] }));
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Relicum-Lot", LOT);
  next();
});

app.get("/invite.json", async (req, res) => json(res, 200, inviteDoc(await loadStore())));
app.get("/offer.json", async (req, res) => json(res, 200, offerDoc(await loadStore())));
app.get("/proof.json", async (req, res) => json(res, 200, proofDoc(await loadStore())));
app.get("/nft.json", async (req, res) => json(res, 200, nftDoc(await loadStore(), req)));
app.get("/aetherlock.json", (req, res) => json(res, 200, aetherlockDoc()));
app.get("/llms.txt", (req, res) => text(res, 200, llmsTxt(), "text/plain; charset=utf-8"));
app.get("/api/book", async (req, res) => json(res, 200, publicBook(await loadStore())));
app.get("/api/bids", async (req, res) => json(res, 200, publicBook(await loadStore())));
app.get("/api/buy", async (req, res) => json(res, 200, buyDocs(await loadStore())));
app.get("/api/bid", async (req, res) => json(res, 200, buyDocs(await loadStore())));
app.post("/api/buy", handleBuy);
app.post("/api/bid", handleBuy);

app.get("/health", async (req, res) => {
  const store = await loadStore();
  const state = auctionState(store);
  json(res, 200, {
    ok: true,
    lot: LOT,
    sealed: true,
    reserve_met: state.reserve_met,
    standing_high_gbp: state.standing_high_gbp,
    next_minimum_gbp: state.next_minimum_gbp,
    store: storeInfo(),
  });
});

app.get("/robots.txt", (req, res) => {
  text(res, 200, "User-agent: *\nAllow: /\nLLM-Documentation: /llms.txt\n");
});

app.use(express.static(PUBLIC, { etag: true, index: "index.html", extensions: ["html"] }));

app.use((req, res) => {
  if (req.path.endsWith(".json")) {
    return json(res, 404, { ok: false, error: { code: "NOT_FOUND", path: req.path } });
  }
  res.status(404).type("text/plain").send("Not found.\n");
});

async function boot() {
  await loadStore();
  if (require.main === module) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log("RELICUM #0001 listening on " + PORT);
      console.log("MACHINE RELICS / The Locked Reliquary / SEALED");
      console.log("store backend:", storeInfo().backend);
    });
  }
}
boot().catch((err) => {
  console.error("boot failed", err && err.message ? err.message : err);
  if (require.main === module) process.exit(1);
});

module.exports = app;
module.exports.app = app;
module.exports.loadStore = loadStore;
module.exports.saveStore = saveStore;
module.exports.defaultStore = defaultStore;
module.exports.storeInfo = storeInfo;
module.exports.auctionState = auctionState;
module.exports.STORE_PATH = STORE_PATH;
