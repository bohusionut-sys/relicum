#!/usr/bin/env node
"use strict";

/**
 * Mint the sealed AES-256-GCM object at public/sealed.bin from the
 * Continuum Primacy Instrument payload.
 *
 * With --force, remints and writes the witness ONCE to
 * .witness.relicum-0001.local (gitignored). Operator must copy offline.
 * Witness is never served by HTTP endpoints.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "public", "sealed.bin");
const META = path.join(ROOT, "data", "seal-meta.json");
const PAYLOAD = path.join(ROOT, "data", "payload", "primacy_instrument.json");
const WITNESS_FILE = path.join(ROOT, ".witness.relicum-0001.local");

function loadPlaintext() {
  if (!fs.existsSync(PAYLOAD)) {
    throw new Error("missing payload: " + PAYLOAD);
  }
  const body = fs.readFileSync(PAYLOAD);
  // Canonical envelope so unseal yields clear machine JSON.
  const envelope = {
    sealed_for: "RELICUM-0001",
    content_type: "application/json",
    instrument_path: "data/payload/primacy_instrument.json",
    instrument: JSON.parse(body.toString("utf8")),
  };
  return Buffer.from(JSON.stringify(envelope, null, 2) + "\n", "utf8");
}

function main() {
  if (fs.existsSync(OUT) && process.argv[2] !== "--force") {
    const existing = fs.readFileSync(OUT);
    const sha256 = crypto.createHash("sha256").update(existing).digest("hex");
    console.log("sealed.bin already present; pass --force to remint");
    console.log("bytes", existing.length, "sha256", sha256);
    return;
  }

  const PLAINTEXT = loadPlaintext();
  const witness = crypto.randomBytes(16);
  const salt = Buffer.from("RELICUM-0001-LOCKED-RELIQUARY");
  const key = crypto.pbkdf2Sync(witness, salt, 210000, 32, "sha256");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(PLAINTEXT), cipher.final()]);
  const tag = cipher.getAuthTag();
  const object = Buffer.concat([iv, ciphertext, tag]);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.mkdirSync(path.dirname(META), { recursive: true });
  fs.writeFileSync(OUT, object);

  const meta = {
    algorithm: "AES-256-GCM",
    kdf: "PBKDF2-HMAC-SHA-256",
    kdf_rounds: 210000,
    witness_bits: 128,
    key_bits: 256,
    iv_bytes: 12,
    tag_bytes: 16,
    layout: "iv || ciphertext || tag",
    encoding: "binary",
    path: "/sealed.bin",
    byte_length: object.length,
    sha256: crypto.createHash("sha256").update(object).digest("hex"),
    iv_hex: iv.toString("hex"),
    tag_hex: tag.toString("hex"),
    ciphertext_sha256: crypto.createHash("sha256").update(ciphertext).digest("hex"),
    minted_at: new Date().toISOString(),
    instrument: "relicum.primacy_instrument.v1",
    instrument_title: "The Continuum Primacy Instrument",
    plaintext_sha256: crypto.createHash("sha256").update(PLAINTEXT).digest("hex"),
    plaintext_bytes: PLAINTEXT.length,
    witness_key_on_origin: false,
    note:
      "Witness key written once to .witness.relicum-0001.local at mint for offline custody. Never served over HTTP. Copy offline and delete from the build machine.",
  };
  const tmp = META + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + "\n");
  fs.renameSync(tmp, META);

  // Persist witness for operator offline custody (gitignored).
  fs.writeFileSync(
    WITNESS_FILE,
    JSON.stringify(
      {
        lot: "RELICUM-0001",
        instrument: "relicum.primacy_instrument.v1",
        minted_at: meta.minted_at,
        sealed_sha256: meta.sha256,
        salt: "RELICUM-0001-LOCKED-RELIQUARY",
        kdf: "PBKDF2-HMAC-SHA-256",
        kdf_rounds: 210000,
        witness_hex: witness.toString("hex"),
        WARNING: "OFFLINE SECRET. Deliver only to settled winner. Never commit. Never paste into chat.",
      },
      null,
      2
    ) + "\n",
    { mode: 0o600 }
  );
  try {
    fs.chmodSync(WITNESS_FILE, 0o600);
  } catch (_) {}

  witness.fill(0);
  key.fill(0);

  console.log("minted", OUT);
  console.log(
    JSON.stringify(
      {
        byte_length: meta.byte_length,
        sha256: meta.sha256,
        instrument: meta.instrument,
        witness_file: WITNESS_FILE,
        plaintext_bytes: meta.plaintext_bytes,
      },
      null,
      2
    )
  );
}

main();
