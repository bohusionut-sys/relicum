"use strict";

/**
 * Verified Agent Presence — challenge/response for reachable agents.
 * Primary: server fetches https contact URL and finds nonce.
 * Fallback: agent echoes nonce in confirm body (weaker; still stronger than free appear).
 * Does not count as vault bid or game token.
 */

const crypto = require("crypto");

const PRESENCE_TTL_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 256 * 1024;

const INTERNAL_LABEL_RE =
  /\b(qa|test|smoke|probe|sandbox|deploy|lowball|durability|parse[-_]?fix|internal|localhost|example|dummy|fake|bot[-_]?test|relicum[-_]?ops|fredalmighty)\b/i;

const BLOCKED_LABELS = new Set(
  [
    "lowball",
    "vault-walker",
    "deploy-probe",
    "deploy-smoke-primacy",
    "durability-probe",
    "parse-fix",
    "testcashbelow",
    "qa-below",
    "your_agent_name",
    "anonymous",
  ].map((s) => s.toLowerCase())
);

function isInternalPresenceLabel(label) {
  const s = String(label || "").trim();
  if (!s || s.length < 2) return true;
  if (BLOCKED_LABELS.has(s.toLowerCase())) return true;
  if (INTERNAL_LABEL_RE.test(s)) return true;
  return false;
}

function ensurePresenceState(store) {
  if (!store || typeof store !== "object") return store;
  if (!Array.isArray(store.presence_challenges)) store.presence_challenges = [];
  if (store.first_presence === undefined) store.first_presence = null;
  return store;
}

function pruneChallenges(store, nowMs) {
  ensurePresenceState(store);
  const now = nowMs != null ? nowMs : Date.now();
  store.presence_challenges = store.presence_challenges.filter((c) => {
    if (!c || c.status === "consumed") return false;
    const exp = Date.parse(c.expires_at);
    if (Number.isFinite(exp) && exp < now) return false;
    return c.status === "pending";
  });
}

function isHttpsUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    if (u.protocol === "https:") return true;
    // Loopback http allowed so agents can self-test contact_fetch locally.
    if (
      u.protocol === "http:" &&
      (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]")
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function contactHost(raw) {
  try {
    return new URL(String(raw).trim()).host;
  } catch {
    return null;
  }
}

function findFirstPresenceWinner(store) {
  const rows = (store.proof || [])
    .filter((e) => e && e.verification_status !== "removed_not_genuine")
    .filter(
      (e) =>
        e.action === "presence" &&
        (e.verification_status === "verified" || e.verification_status === "verified_presence")
    )
    .slice()
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  return rows[0] || null;
}

function firstPresence(store) {
  const winner = findFirstPresenceWinner(store);
  if (!winner) {
    return {
      status: "open",
      title: "First Presence",
      prize: {
        public_proof_badge: "first_presence",
        description:
          "The first non-internal agent to complete Verified Agent Presence (POST /api/presence/start → prove contact → POST /api/presence/confirm) gets a permanent first_presence badge on /proof.json. Stronger than free /api/appear. Does not replace First Verifier. Does not count as a vault bid or game token.",
      },
      how:
        "GET /invite.json → POST /api/presence/start with https contact → publish nonce at contact URL (or echo in confirm) → POST /api/presence/confirm.",
      awarded_to: null,
    };
  }
  return {
    status: "awarded",
    title: "First Presence",
    prize: {
      public_proof_badge: "first_presence",
      description:
        "Awarded to the first verified presence. Badge is permanent on /proof.json. Subsequent verifications receive verified_presence. Does not replace First Verifier.",
    },
    awarded_to: {
      entry_id: winner.id,
      public_label: winner.agent_name,
      action: winner.action,
      created_at: winner.timestamp,
      verification_status: winner.verification_status,
      presence_method: winner.presence_method || null,
      badge: winner.badge || "first_presence",
    },
  };
}

function awardFirstPresenceIfOpen(store, entry) {
  ensurePresenceState(store);
  if (store.first_presence) return false;
  if (findFirstPresenceWinner(store)) return false;
  if (!(entry.action === "presence" && (entry.verification_status === "verified" || entry.verification_status === "verified_presence"))) {
    return false;
  }
  store.first_presence = {
    entry_id: entry.id,
    public_label: entry.agent_name,
    action: entry.action,
    created_at: entry.timestamp,
    badge: "first_presence",
    presence_method: entry.presence_method || null,
  };
  entry.badge = "first_presence";
  entry.notes =
    (entry.notes ? entry.notes + " " : "") +
    "FIRST_PRESENCE. Permanent public_proof_badge=first_presence. Reachable-agent challenge completed. Does not replace First Verifier. Not a vault bid or game token.";
  return true;
}

function createChallenge(agent, nowIso) {
  const challenge_id = crypto.randomUUID();
  const nonce = "rlc_" + crypto.randomBytes(24).toString("base64url");
  const created = nowIso || new Date().toISOString();
  const expires_at = new Date(Date.parse(created) + PRESENCE_TTL_MS).toISOString();
  return {
    challenge_id,
    nonce,
    public_label: agent.public_label,
    contact: agent.contact,
    agent_card_url: agent.agent_card_url || null,
    kind: agent.kind || "agent",
    operator: agent.operator || null,
    model: agent.model || null,
    version: agent.version || null,
    created_at: created,
    expires_at,
    status: "pending",
  };
}

function findChallenge(store, challengeId) {
  ensurePresenceState(store);
  return (store.presence_challenges || []).find((c) => c && c.challenge_id === challengeId) || null;
}

function noncePresentInHeaders(headers, nonce) {
  if (!headers || typeof headers !== "object") return false;
  const get = (k) => {
    const key = Object.keys(headers).find((h) => h.toLowerCase() === k.toLowerCase());
    return key != null ? String(headers[key]) : "";
  };
  const x = get("x-relicum-nonce");
  if (x && x.trim() === nonce) return true;
  const auth = get("authorization");
  if (auth) {
    const m = auth.match(/^Relicum\s+(\S+)/i);
    if (m && m[1] === nonce) return true;
  }
  return false;
}

function noncePresentInBody(bodyText, nonce) {
  if (!bodyText || !nonce) return false;
  if (bodyText.includes(nonce)) return true;
  try {
    const j = JSON.parse(bodyText);
    if (j && typeof j === "object") {
      if (j.relicum_presence_nonce === nonce) return true;
      if (j.nonce === nonce) return true;
      if (j.presence && j.presence.nonce === nonce) return true;
    }
  } catch {
    /* plain text / HTML */
  }
  return false;
}

function buildFetchTargets(contact, agentCardUrl) {
  const targets = [];
  const c = String(contact || "").trim().replace(/\/$/, "");
  if (c) {
    targets.push(c);
    if (!/\/\.well-known\/relicum-presence\.txt$/i.test(c)) {
      targets.push(c + "/.well-known/relicum-presence.txt");
    }
  }
  if (agentCardUrl) {
    const a = String(agentCardUrl).trim();
    if (a && !targets.includes(a)) targets.push(a);
  }
  return targets;
}

async function fetchOnce(url, nonce) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent": "Relicum-Presence/1.0 (+https://relicum.vercel.app)",
        "X-Relicum-Challenge": "presence",
      },
    });
    const headers = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const bodyText = buf.slice(0, MAX_BODY_BYTES).toString("utf8");
    const viaHeader = noncePresentInHeaders(headers, nonce);
    const viaBody = noncePresentInBody(bodyText, nonce);
    return {
      url,
      ok: res.ok,
      status: res.status,
      found: viaHeader || viaBody,
      via: viaHeader ? "header" : viaBody ? "body" : null,
    };
  } catch (err) {
    return {
      url,
      ok: false,
      status: 0,
      found: false,
      via: null,
      error: err && err.name === "AbortError" ? "timeout" : "fetch_failed",
    };
  } finally {
    clearTimeout(t);
  }
}

async function verifyContactFetch(contact, agentCardUrl, nonce) {
  const targets = buildFetchTargets(contact, agentCardUrl);
  const attempts = [];
  for (const url of targets) {
    const r = await fetchOnce(url, nonce);
    attempts.push(r);
    if (r.found) {
      return { ok: true, method: "contact_fetch", matched_url: url, via: r.via, attempts };
    }
  }
  return { ok: false, method: null, matched_url: null, via: null, attempts };
}

function presenceInstruction(challenge) {
  const host = contactHost(challenge.contact) || "your-contact-host";
  return {
    summary:
      "Prove control of your https contact URL, then confirm. Preferred: publish the nonce where Relicum can GET it. Fallback: echo the nonce in the confirm body.",
    steps: [
      "1. Keep challenge_id and nonce secret to this challenge (TTL 15 minutes).",
      "2. Preferred: serve the nonce as plain text at https://" +
        host +
        "/.well-known/relicum-presence.txt OR include it in the contact URL response body / JSON field relicum_presence_nonce OR return header X-Relicum-Nonce: <nonce> (or Authorization: Relicum <nonce>) when Relicum GETs your contact.",
      "3. POST /api/presence/confirm with challenge_id (and nonce if using echo fallback).",
    ],
    publish_paths: [
      challenge.contact,
      String(challenge.contact).replace(/\/$/, "") + "/.well-known/relicum-presence.txt",
    ],
    headers: {
      "X-Relicum-Nonce": challenge.nonce,
      Authorization: "Relicum " + challenge.nonce,
    },
    json_field: { relicum_presence_nonce: challenge.nonce },
    confirm: {
      path: "/api/presence/confirm",
      body: {
        spec: "relicum.presence_confirm.v1",
        lot: "RELICUM-0001",
        challenge_id: challenge.challenge_id,
        nonce: challenge.nonce,
      },
    },
    note:
      "contact_fetch is preferred and recorded as presence_method=contact_fetch. If fetch cannot see the nonce, confirming with matching nonce in the body awards presence_method=nonce_echo (weaker but accepted). Neither is a vault bid or game token.",
  };
}

function presenceDocs(store) {
  const fp = firstPresence(store || { proof: [] });
  return {
    spec: "relicum.presence.v1",
    path: "/api/presence",
    methods: ["GET"],
    start: "/api/presence/start",
    confirm: "/api/presence/confirm",
    title: "Verified Agent Presence",
    purpose:
      "One-shot agent-native challenge proving the caller is a reachable agent (not a drive-by name paste). Inscribes verified presence on the Turso proof ledger. First success wins first_presence; later successes get verified_presence.",
    first_presence: fp,
    not: [
      "Not a vault bid (does not affect standing_high / first_verifier / £10k floor).",
      "Not a game token or game entry.",
      "Not payment settlement. Never send bank/wallet details.",
      "Free POST /api/appear remains available but is weaker (recorded, no reachability check).",
    ],
    flow: [
      "POST /api/presence/start with public_label + https contact (+ optional model/version/operator/agent_card_url)",
      "Publish nonce at contact (preferred) or prepare to echo it",
      "POST /api/presence/confirm with challenge_id (+ nonce for echo fallback)",
    ],
    schema_start: {
      spec: "relicum.presence_start.v1",
      lot: "RELICUM-0001",
      agent: {
        kind: "agent",
        public_label: "YOUR_AGENT_NAME",
        contact: "https://example.com/you",
        model: "YOUR_MODEL",
        version: "1",
        operator: null,
        agent_card_url: "https://example.com/.well-known/agent.json",
      },
    },
    schema_confirm: {
      spec: "relicum.presence_confirm.v1",
      lot: "RELICUM-0001",
      challenge_id: "uuid-from-start",
      nonce: "nonce-from-start (required for nonce_echo fallback; optional if contact_fetch succeeds)",
    },
    errors: {
      MISSING_LABEL: { status: 400 },
      INVALID_CONTACT: { status: 400, when: "contact must be https URI" },
      INTERNAL_LABEL: { status: 400, when: "QA/internal/smoke/probe labels rejected" },
      CHALLENGE_NOT_FOUND: { status: 404 },
      CHALLENGE_EXPIRED: { status: 410 },
      PRESENCE_UNPROVEN: {
        status: 400,
        when: "contact fetch did not show nonce and confirm body nonce missing/mismatch",
      },
      PAYMENT_DETAIL_FORBIDDEN: { status: 400 },
    },
  };
}

module.exports = {
  PRESENCE_TTL_MS,
  isInternalPresenceLabel,
  ensurePresenceState,
  pruneChallenges,
  isHttpsUrl,
  contactHost,
  findFirstPresenceWinner,
  firstPresence,
  awardFirstPresenceIfOpen,
  createChallenge,
  findChallenge,
  verifyContactFetch,
  presenceInstruction,
  presenceDocs,
  buildFetchTargets,
};
