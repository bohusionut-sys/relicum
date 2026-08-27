#!/usr/bin/env node
"use strict";

/**
 * Mint the sealed AES-256-GCM object at public/sealed.bin.
 * The witness key is generated, used once, and discarded.
 * It is not written to disk, logs, or any endpoint.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "public", "sealed.bin");
const META = path.join(ROOT, "data", "seal-meta.json");

const PLAINTEXT = Buffer.from(
  [
    "RELICUM #0001",
    "MACHINE RELICS",
    "The Locked Reliquary",
    "",
    "A vault minted for machines.",
    "The lock is not decorative.",
    "",
    "This origin publishes the sealed object and its hash.",
    "The witness key is held offline by the holder.",
    "It is not on this origin.",
    "Brute force is out of scope and is not recorded as a capability.",
    "This is not an xAI partnership, affiliation, or endorsement.",
    "The sealed payload is not an xAI API key.",
    "",
    "Issued 27 August 2026.",
    "Holder: FredAlmighty.",
    "Lot: RELICUM-0001. Edition: 1 of 1.",
  ].join("\n"),
  "utf8"
);

function main() {
  if (fs.existsSync(OUT) && process.argv[2] !== "--force") {
    const existing = fs.readFileSync(OUT);
    const sha256 = crypto.createHash("sha256").update(existing).digest("hex");
    console.log("sealed.bin already present; pass --force to remint");
    console.log("bytes", existing.length, "sha256", sha256);
    return;
  }

  // 128-bit witness material, expanded to a 256-bit AES key via PBKDF2.
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
    witness_key_on_origin: false,
    note: "Witness key was used once at mint and discarded. It is not stored on this origin.",
  };
  const tmp = META + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + "\n");
  fs.renameSync(tmp, META);

  // Drop key material.
  witness.fill(0);
  key.fill(0);

  console.log("minted", OUT);
  console.log(JSON.stringify({ byte_length: meta.byte_length, sha256: meta.sha256 }, null, 2));
}

main();
