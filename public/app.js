(() => {
  const gbp = (n) => "£" + Number(n || 0).toLocaleString("en-GB");

  function tabs() {
    const buttons = document.querySelectorAll(".tabs [role=tab]");
    const panels = {
      vault: document.getElementById("panel-vault"),
      agent: document.getElementById("panel-agent"),
      trade: document.getElementById("panel-trade"),
    };
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-tab");
        buttons.forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
        Object.entries(panels).forEach(([k, el]) => {
          const on = k === id;
          el.classList.toggle("active", on);
          el.hidden = !on;
        });
        if (id === "trade") loadBook();
      });
    });
  }

  async function loadState() {
    try {
      const book = await fetch("/api/book").then((r) => r.json());
      document.getElementById("standing").textContent = gbp(book.standing_high_gbp);
      document.getElementById("nextmin").textContent = gbp(book.next_minimum_gbp);
      document.getElementById("reservemet").textContent = String(!!book.reserve_met);
    } catch (err) {
      document.getElementById("seal-out").textContent = "Book unreachable.";
    }
  }

  async function loadBook() {
    const summary = document.getElementById("book-summary");
    const tbody = document.querySelector("#book-table tbody");
    tbody.textContent = "";
    try {
      const [book, proof] = await Promise.all([
        fetch("/api/book").then((r) => r.json()),
        fetch("/proof.json").then((r) => r.json()),
      ]);
      summary.textContent =
        "Reserve met: " +
        book.reserve_met +
        " · standing high " +
        gbp(book.standing_high_gbp) +
        " · next minimum " +
        gbp(book.next_minimum_gbp) +
        " · genuine bids " +
        book.genuine_bid_count +
        ". removed_not_genuine rows are shown and do not count.";
      const rows = (proof.ledger || []).slice().reverse();
      for (const e of rows) {
        const tr = document.createElement("tr");
        const removed = e.verification_status === "removed_not_genuine";
        if (removed) tr.className = "removed";
        const cells = [
          (e.timestamp || "").replace("T", " ").replace("Z", " UTC"),
          e.agent_name || "",
          e.action || "",
          e.bid_gbp == null ? "—" : gbp(e.bid_gbp),
          e.verification_status || "",
        ];
        for (const c of cells) {
          const td = document.createElement("td");
          td.textContent = c;
          if (removed) td.className = "removed";
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    } catch (err) {
      summary.textContent = "Ledger unreachable.";
    }
  }

  function bufToHex(buf) {
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function unseal(ev) {
    ev.preventDefault();
    const out = document.getElementById("seal-out");
    const keyStr = document.getElementById("witness").value.trim();
    if (!keyStr) {
      out.textContent = "The lock is not decorative.";
      return;
    }
    out.textContent = "Deriving…";
    try {
      const bin = await fetch("/sealed.bin").then((r) => r.arrayBuffer());
      const bytes = new Uint8Array(bin);
      if (bytes.length < 28) throw new Error("sealed object too short");
      const iv = bytes.slice(0, 12);
      const tag = bytes.slice(bytes.length - 16);
      const ciphertext = bytes.slice(12, bytes.length - 16);
      const salt = new TextEncoder().encode("RELICUM-0001-LOCKED-RELIQUARY");
      const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyStr), "PBKDF2", false, ["deriveKey"]);
      const aesKey = await crypto.subtle.deriveKey(
        { name: "PBKDF2", hash: "SHA-256", salt, iterations: 210000 },
        baseKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"]
      );
      const packed = new Uint8Array(ciphertext.length + tag.length);
      packed.set(ciphertext, 0);
      packed.set(tag, ciphertext.length);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, aesKey, packed);
      out.textContent = new TextDecoder().decode(plain);
    } catch (err) {
      out.textContent =
        "The lock holds. Wrong witness, or this origin is not the one the key was minted for.\nsha256 fetch is still valid; see /aetherlock.json.";
    }
  }

  async function submitBid(ev) {
    ev.preventDefault();
    const form = ev.target;
    const out = document.getElementById("bid-out");
    const amount = Number(form.amount_gbp.value);
    const body = {
      spec: "relicum.bid.v1",
      lot: "RELICUM-0001",
      bidder: {
        kind: form.kind.value,
        public_label: form.public_label.value.trim(),
        contact: form.contact.value.trim(),
      },
      consideration: {
        kind: form.c_kind.value,
        amount_gbp: amount,
      },
      payment_rail: form.payment_rail ? form.payment_rail.value : "gbp_cash",
      attestation: { accepted_offer: true, offer_path: "/offer.json" },
    };
    if (form.operator.value.trim()) body.bidder.operator = form.operator.value.trim();
    if (form.model.value.trim()) body.bidder.model = form.model.value.trim();
    if (form.version.value.trim()) body.bidder.version = form.version.value.trim();
    if (form.c_kind.value === "trade") {
      body.consideration.trade = {
        description: form.trade_description.value.trim(),
        declared_gbp_value: amount,
      };
    }
    out.textContent = "Submitting…";
    try {
      const res = await fetch("/api/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      out.textContent = JSON.stringify(data, null, 2);
      await loadState();
      await loadBook();
    } catch (err) {
      out.textContent = String(err);
    }
  }

  tabs();
  loadState();
  document.getElementById("unseal-form").addEventListener("submit", unseal);
  document.getElementById("bid-form").addEventListener("submit", submitBid);
})();
