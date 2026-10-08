// Telehealth Checkout — Demo
//
// Static, backend-free mock of the "patient selects a prescription, confirms
// dosage, pays" checkout feature from the Q3 interview screening question.
// Built to exercise the 18 cases in Q3_Telehealth_Checkout_TestCases.xlsx
// (9 Critical Blockers, 6 Edge Cases, 3 Failure Modes) as real, clickable
// behavior rather than static mockup text — so it can both (a) be driven by
// a hand-written E2E Playwright test and (b) get captured by the agentic
// pipeline for generated-test-case automation, the same way demo_mock_login
// and demo_login_portal are used elsewhere in this project.
//
// No backend exists, so two things are *simulated* rather than real, and
// both are labelled in the UI/console wherever they appear:
//   - "another device" buying the last unit (TC-06) is a button that sets a
//     flag, not a second real client.
//   - the payment gateway timeout (TC-16) is scaled to ~4s, not the spec's
//     >30s, so a live demo doesn't sit there for half a minute.
// Everything else (dosage/price math, allergy/eligibility checks, session
// timeout, duplicate-click guard, atomic order write, per-patient history
// isolation) is real logic running against the data below.

const TAX_RATE = 0.08;
const SESSION_TIMEOUT_SECONDS = 10; // matches TC-15's own numbers exactly
const GATEWAY_TIMEOUT_MS = 4000; // scaled down from the spec's >30s for live demo purposes
const GATEWAY_NORMAL_MS = 800;

const ELIGIBILITY = {
  ageMin: 18,
  weightMin: 40, weightMax: 150,
  heightMin: 140, heightMax: 210,
};

const PATIENTS = {
  a: { id: "a", name: "Patient A", allergy: "Penicillin" },
  b: { id: "b", name: "Patient B", allergy: null },
  c: { id: "c", name: "Patient C", allergy: null },
};

// one seed order per patient, so every new identity has order history from
// the start (TC-09's isolation check needs each patient to have *something*
// on file, not an empty list)
const SEED_ORDERS = {
  a: { id: "ORD-A1001", med: "Amoxicillin 500mg × 2 capsules", date: "2026-09-15", total: 54.00 },
  b: { id: "ORD-B2001", med: "Ibuprofen 200mg × 1 tablet", date: "2026-09-20", total: 12.96 },
  c: { id: "ORD-C3001", med: "Metformin 500mg × 1 tablet", date: "2026-09-25", total: 19.44 },
};

const MEDICATIONS = {
  "amox-std": {
    id: "amox-std",
    name: "Amoxicillin 500mg × 2 capsules",
    allergen: "Penicillin",
    basePrice: 50.00,
    expiryDays: 180,
    stock: 20,
    hasPrescription: true,
    dosageOptions: [475, 500, 525],
    prescribedDosage: 500,
  },
  "amox-expired": {
    id: "amox-expired",
    name: "Amoxicillin 500mg × 2 capsules (Batch EXP-1)",
    allergen: "Penicillin",
    basePrice: 50.00,
    expiryDays: -1,
    stock: 10,
    hasPrescription: true,
    prescribedDosage: 500,
  },
  "amox-nearexpiry": {
    id: "amox-nearexpiry",
    name: "Amoxicillin 500mg × 2 capsules (Batch EXP-2)",
    allergen: "Penicillin",
    basePrice: 50.00,
    expiryDays: 35,
    stock: 10,
    hasPrescription: true,
    prescribedDosage: 500,
  },
  "amox-lastunit": {
    id: "amox-lastunit",
    name: "Amoxicillin 500mg × 2 capsules (Batch EXP-3)",
    allergen: "Penicillin",
    basePrice: 50.00,
    expiryDays: 180,
    stock: 1,
    hasPrescription: true,
    prescribedDosage: 500,
  },
  "ibuprofen-oos": {
    id: "ibuprofen-oos",
    name: "Ibuprofen 200mg × 1 tablet",
    allergen: "Penicillin",
    basePrice: 12.00,
    expiryDays: 180,
    stock: 0,
    hasPrescription: true,
    prescribedDosage: 200,
  },
  "metformin-noscript": {
    id: "metformin-noscript",
    name: "Metformin 500mg × 1 tablet",
    allergen: null,
    basePrice: 18.00,
    expiryDays: 180,
    stock: 10,
    hasPrescription: false,
    prescribedDosage: 500,
  },
};

function money(n) { return "$" + n.toFixed(2); }

function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function currentPatientId() {
  const p = (getParam("patient") || "a").toLowerCase();
  return PATIENTS[p] ? p : "a";
}

function seedOrderHistory() {
  Object.keys(PATIENTS).forEach(id => {
    if (!localStorage.getItem("orders_" + id)) {
      localStorage.setItem("orders_" + id, JSON.stringify([SEED_ORDERS[id]]));
    }
  });
}

function getOrders(patientId) {
  return JSON.parse(localStorage.getItem("orders_" + patientId) || "[]");
}

function renderPatientBanner(container, patientId) {
  const patient = PATIENTS[patientId];
  const others = Object.keys(PATIENTS).filter(id => id !== patientId);
  const onIndex = !!document.getElementById("medicationList");
  const switchLinks = others.map(id =>
    `<a href="?patient=${id}" data-testid="switch-patient-link-${id}">Switch to Patient ${id.toUpperCase()}</a>`
  ).join(" ");
  container.innerHTML = `
    ${onIndex ? "" : `<a href="index.html?patient=${patientId}" data-testid="home-link">&larr; Pharmacy home</a>`}
    <span data-testid="patient-banner">Checking out as <strong>${patient.name}</strong>${patient.allergy ? ` (documented ${patient.allergy} allergy)` : " (no documented allergies)"}</span>
    <span data-testid="switch-patient-links">${switchLinks}</span>
  `;
}

// ---------------------------------------------------------------------------
// index.html — medication selection
// ---------------------------------------------------------------------------
function initIndexPage() {
  seedOrderHistory();
  const patientId = currentPatientId();
  renderPatientBanner(document.getElementById("patientBanner"), patientId);

  const list = document.getElementById("medicationList");
  const cards = [
    { id: "amox-std", dosage: true },
    { id: "amox-nearexpiry" },
    { id: "amox-expired" },
    { id: "amox-lastunit", concurrent: true },
    { id: "ibuprofen-oos" },
    { id: "metformin-noscript" },
  ];

  list.innerHTML = cards.map(c => {
    const med = MEDICATIONS[c.id];
    const oos = med.stock <= 0;
    const expired = med.expiryDays < 0;
    let meta = `Base ${money(med.basePrice)} · stock ${med.stock}`;
    if (expired) meta += ` · <span class="oos">expired ${Math.abs(med.expiryDays)} day(s) ago</span>`;
    else if (med.expiryDays <= 35) meta += ` · expires in ${med.expiryDays} days`;
    if (oos) meta += ` · <span class="oos">out of stock</span>`;
    if (!med.hasPrescription) meta += ` · <span class="oos">no prescription on file</span>`;
    if (med.allergen) meta += ` · <span class="allergen-tag" data-testid="allergen-tag-${med.id}">contains ${med.allergen}</span>`;

    let dosageControl = "";
    if (c.dosage) {
      dosageControl = `
        <label for="dosageSelect-${med.id}" style="font-size:0.8rem;color:var(--muted);font-weight:600;">Dosage</label>
        <select id="dosageSelect-${med.id}" data-testid="dosage-select-${med.id}">
          ${med.dosageOptions.map(d => `<option value="${d}" ${d === med.prescribedDosage ? "selected" : ""}>${d}mg${d === med.prescribedDosage ? " (prescribed)" : ""}</option>`).join("")}
        </select>
      `;
    }

    let concurrentButton = "";
    if (c.concurrent) {
      concurrentButton = `
        <button type="button" class="secondary" id="simulateConcurrent-${med.id}" data-testid="simulate-concurrent-button">
          ⚠️ Simulate: another device just bought the last unit
        </button>
        <span id="concurrentNote-${med.id}" data-testid="concurrent-note"></span>
      `;
    }

    return `
      <div class="med-card" data-testid="med-card-${med.id}">
        <h3>${med.name}</h3>
        <div class="meta">${meta}</div>
        <div class="row">
          ${dosageControl}
          <button type="button" class="primary" id="select-${med.id}" data-testid="select-med-${med.id}">
            Select
          </button>
          ${concurrentButton}
        </div>
      </div>
    `;
  }).join("");

  cards.forEach(c => {
    const med = MEDICATIONS[c.id];
    document.getElementById("select-" + med.id).addEventListener("click", () => {
      let url = `review.html?med=${med.id}&patient=${patientId}`;
      if (c.dosage) {
        const dosage = document.getElementById("dosageSelect-" + med.id).value;
        url += `&dosage=${dosage}`;
      }
      window.location.href = url;
    });
    if (c.concurrent) {
      document.getElementById("simulateConcurrent-" + med.id).addEventListener("click", () => {
        sessionStorage.setItem("concurrent_" + med.id, "true");
        document.getElementById("concurrentNote-" + med.id).textContent =
          " Simulated: last unit just taken by another device.";
      });
    }
  });
}

// ---------------------------------------------------------------------------
// review.html — dosage/price/allergy/eligibility review + payment
// ---------------------------------------------------------------------------
function initReviewPage() {
  const patientId = currentPatientId();
  const patient = PATIENTS[patientId];
  const medId = getParam("med") || "amox-std";
  const med = MEDICATIONS[medId] || MEDICATIONS["amox-std"];
  const dosage = parseInt(getParam("dosage") || med.prescribedDosage, 10);

  renderPatientBanner(document.getElementById("patientBanner"), patientId);

  // declared up front: several sections below call updatePayState() as soon
  // as they're wired up (eligibility inputs, tolerance checkbox), so both
  // this and payButton itself need to exist before any of that runs
  const payButton = document.getElementById("payButton");
  function updatePayState() {
    const hardBlocked = expired || outOfStock || concurrentTaken || noPrescription || allergyConflict;
    payButton.disabled = hardBlocked || !toleranceConfirmed || !eligibilityOk;
  }

  // --- blocking checks (evaluated independently; all shown, Pay disabled if any fire) ---
  const blocks = [];
  const expired = med.expiryDays < 0;
  const outOfStock = med.stock <= 0;
  const noPrescription = !med.hasPrescription;
  const allergyConflict = patient.allergy && med.allergen === patient.allergy;
  const concurrentTaken = sessionStorage.getItem("concurrent_" + med.id) === "true";

  if (expired) {
    blocks.push(`<div class="block-message" data-testid="expired-block-message">This medication is no longer available.</div>`);
  }
  if (outOfStock || concurrentTaken) {
    blocks.push(`<div class="block-message" data-testid="out-of-stock-block-message">Out of stock. ${med.name} is no longer available. Check back on 2026-10-15, or we'll notify you when back in stock.</div>`);
  }
  if (noPrescription) {
    blocks.push(`<div class="block-message" data-testid="no-prescription-block-message">No valid prescription on file for this medication. Please contact your healthcare provider or upload a new prescription.</div>`);
  }
  if (allergyConflict) {
    blocks.push(`<div class="block-message" data-testid="allergy-block-message">⚠️ Allergy detected. You have a documented ${patient.allergy} allergy. ${med.name.split(" ")[0]} contains ${patient.allergy}. Order blocked for your safety. Contact your doctor for an alternative.</div>`);
  }
  document.getElementById("blockMessages").innerHTML = blocks.join("");

  // --- dosage confirmation ---
  const dosageWithinTolerance = dosage !== med.prescribedDosage;
  let dosageHtml = `<div data-testid="dosage-confirm">Dosage: <strong>${dosage}mg</strong> (prescribed: ${med.prescribedDosage}mg)</div>`;
  document.getElementById("medSummary").innerHTML = `
    <h2>${med.name} ${med.allergen ? `<span class="allergen-tag" data-testid="allergen-tag">contains ${med.allergen}</span>` : ""}</h2>
    ${med.expiryDays >= 0 && med.expiryDays <= 35 ? `<div class="note-message" data-testid="expiry-note">Expires in ${med.expiryDays} days — within the pharmacy's dispensable window.</div>` : ""}
    ${dosageHtml}
  `;

  let toleranceConfirmed = !dosageWithinTolerance;
  if (dosageWithinTolerance) {
    const pct = Math.round(((dosage - med.prescribedDosage) / med.prescribedDosage) * 100);
    document.getElementById("toleranceBlock").innerHTML = `
      <div class="checkbox-row">
        <input type="checkbox" id="toleranceConfirm" data-testid="dosage-tolerance-confirm">
        <label for="toleranceConfirm">Pharmacy offers ${dosage}mg (${pct > 0 ? "+" : ""}${pct}% of prescribed ${med.prescribedDosage}mg). Acceptable?</label>
      </div>
    `;
    document.getElementById("toleranceConfirm").addEventListener("change", (e) => {
      toleranceConfirmed = e.target.checked;
      updatePayState();
    });
  }

  // --- price breakdown ---
  const tax = med.basePrice * TAX_RATE;
  const total = med.basePrice + tax;
  document.getElementById("priceBreakdown").innerHTML = `
    <table class="price-table" data-testid="price-breakdown">
      <tr><td>Base price</td><td>${money(med.basePrice)}</td></tr>
      <tr><td>Tax (8%)</td><td>${money(tax)}</td></tr>
      <tr class="total"><td>Total</td><td data-testid="total-amount">${money(total)}</td></tr>
    </table>
  `;

  // --- eligibility (age/weight/height) ---
  // hints generated from ELIGIBILITY itself so they can't drift from the
  // actual check below
  document.getElementById("ageThreshold").textContent = `(eligible: ≥${ELIGIBILITY.ageMin})`;
  document.getElementById("weightThreshold").textContent = `(eligible: ${ELIGIBILITY.weightMin}–${ELIGIBILITY.weightMax})`;
  document.getElementById("heightThreshold").textContent = `(eligible: ${ELIGIBILITY.heightMin}–${ELIGIBILITY.heightMax})`;

  function evalEligibility() {
    const age = parseInt(document.getElementById("ageInput").value, 10);
    const weight = parseFloat(document.getElementById("weightInput").value);
    const height = parseFloat(document.getElementById("heightInput").value);
    const ageOk = age >= ELIGIBILITY.ageMin;
    const weightOk = weight >= ELIGIBILITY.weightMin && weight <= ELIGIBILITY.weightMax;
    const heightOk = height >= ELIGIBILITY.heightMin && height <= ELIGIBILITY.heightMax;
    document.getElementById("ageResult").textContent = ageOk ? "Eligible" : "Rejected";
    document.getElementById("ageResult").className = "result " + (ageOk ? "pass" : "fail");
    document.getElementById("weightResult").textContent = weightOk ? "Eligible" : "Rejected";
    document.getElementById("weightResult").className = "result " + (weightOk ? "pass" : "fail");
    document.getElementById("heightResult").textContent = heightOk ? "Eligible" : "Rejected";
    document.getElementById("heightResult").className = "result " + (heightOk ? "pass" : "fail");
    eligibilityOk = ageOk && weightOk && heightOk;
    updatePayState();
  }
  let eligibilityOk = true;
  ["ageInput", "weightInput", "heightInput"].forEach(id =>
    document.getElementById(id).addEventListener("input", evalEligibility)
  );
  evalEligibility();

  // --- session timer ---
  const startTime = Date.now();
  const timerEl = document.getElementById("sessionTimer");
  function tick() {
    const elapsed = (Date.now() - startTime) / 1000;
    const remaining = Math.max(0, SESSION_TIMEOUT_SECONDS - elapsed);
    timerEl.textContent = remaining > 0
      ? `Session expires in ${remaining.toFixed(1)}s`
      : "Session expired";
    timerEl.className = "timer" + (remaining <= 3 ? " urgent" : "");
  }
  tick();
  const timerInterval = setInterval(tick, 200);

  // pay button + updatePayState were declared up top; re-run it once now
  // that every input (tolerance, eligibility) has reported in
  updatePayState();

  // --- cancel: no charge, no order, back to catalog ---
  document.getElementById("cancelButton").addEventListener("click", () => {
    window.location.href = `index.html?patient=${patientId}`;
  });

  // --- pay flow ---
  let paymentInProgress = false;
  const errorEl = document.getElementById("paymentErrorMessage");
  const stateEl = document.getElementById("transactionState");

  payButton.addEventListener("click", () => {
    if (paymentInProgress) {
      errorEl.textContent = "Transaction in progress. Please wait.";
      errorEl.setAttribute("data-testid", "duplicate-submit-message");
      return; // duplicate-click guard (TC-07)
    }

    // Defense-in-depth: `payButton.disabled` is a UI convenience, not the
    // actual safety check. Re-validate every hard gate here too, so
    // re-enabling the button from devtools (or any other client-side
    // bypass) still can't push an unsafe order through — the same
    // "block before payment, not just disable the button" intent TC-08
    // and friends already describe.
    if (expired) {
      errorEl.textContent = "This medication is no longer available.";
      errorEl.setAttribute("data-testid", "expired-block-message");
      payButton.disabled = true;
      return;
    }
    if (outOfStock || sessionStorage.getItem("concurrent_" + med.id) === "true") {
      errorEl.textContent = `Out of stock. ${med.name} is no longer available. Check back on 2026-10-15, or we'll notify you when back in stock.`;
      errorEl.setAttribute("data-testid", "out-of-stock-block-message");
      payButton.disabled = true;
      return;
    }
    if (noPrescription) {
      errorEl.textContent = "No valid prescription on file for this medication. Please contact your healthcare provider or upload a new prescription.";
      errorEl.setAttribute("data-testid", "no-prescription-block-message");
      payButton.disabled = true;
      return;
    }
    if (allergyConflict) {
      errorEl.textContent = `⚠️ Allergy detected. You have a documented ${patient.allergy} allergy. ${med.name.split(" ")[0]} contains ${patient.allergy}. Order blocked for your safety. Contact your doctor for an alternative.`;
      errorEl.setAttribute("data-testid", "allergy-block-message");
      payButton.disabled = true;
      return;
    }
    if (!toleranceConfirmed) {
      errorEl.textContent = "Confirm the dosage substitution before paying.";
      errorEl.setAttribute("data-testid", "dosage-tolerance-unconfirmed-message");
      return;
    }
    if (!eligibilityOk) {
      errorEl.textContent = "This patient does not meet the eligibility requirements for this prescription.";
      errorEl.setAttribute("data-testid", "eligibility-block-message");
      payButton.disabled = true;
      return;
    }

    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed >= 10 && elapsed < 11) {
      errorEl.textContent = "Session expired. Please retry.";
      errorEl.setAttribute("data-testid", "session-expired-message");
      return;
    }
    if (elapsed >= 11) {
      errorEl.textContent = "Session expired. Start checkout again.";
      errorEl.setAttribute("data-testid", "session-expired-message");
      payButton.disabled = true;
      return;
    }

    errorEl.textContent = "";
    paymentInProgress = true;
    payButton.disabled = true;
    stateEl.textContent = "Transaction state: processing";
    stateEl.setAttribute("data-testid", "transaction-state");

    const slowGateway = document.getElementById("slowGatewayToggle").checked;
    const delay = slowGateway ? GATEWAY_TIMEOUT_MS : GATEWAY_NORMAL_MS;

    setTimeout(() => {
      if (slowGateway) {
        stateEl.textContent = "Transaction state: timed_out";
        errorEl.textContent = "Payment processing took too long. Please retry.";
        errorEl.setAttribute("data-testid", "gateway-timeout-message");
        paymentInProgress = false;
        payButton.disabled = false;
        document.getElementById("retryNote").innerHTML =
          `<button type="button" class="secondary" id="retryButton" data-testid="retry-button">Retry</button>`;
        document.getElementById("retryButton").addEventListener("click", () => {
          document.getElementById("retryNote").innerHTML = "";
          errorEl.textContent = "";
          stateEl.textContent = "";
        });
        return;
      }

      // re-check the concurrent-order flag at the moment of charge, not just
      // at page load, so "simulate concurrent order" works even if clicked
      // after review.html already rendered
      if (sessionStorage.getItem("concurrent_" + med.id) === "true") {
        stateEl.textContent = "Transaction state: rejected";
        errorEl.textContent = `Out of stock. ${med.name} is no longer available. Check back on 2026-10-15, or we'll notify you when back in stock.`;
        errorEl.setAttribute("data-testid", "out-of-stock-block-message");
        paymentInProgress = false;
        payButton.disabled = true;
        return;
      }

      // success: payment + order creation as a single atomic write (TC-05)
      const orderId = "ORD-" + patientId.toUpperCase() + Date.now().toString().slice(-6);
      const orders = getOrders(patientId);
      orders.push({ id: orderId, med: med.name, date: new Date().toISOString().slice(0, 10), total: total });
      localStorage.setItem("orders_" + patientId, JSON.stringify(orders));

      clearInterval(timerInterval);
      stateEl.textContent = "Transaction state: success";
      window.location.href = `confirmation.html?order=${orderId}&patient=${patientId}`;
    }, delay);
  });
}

// ---------------------------------------------------------------------------
// confirmation.html
// ---------------------------------------------------------------------------
function initConfirmationPage() {
  const patientId = currentPatientId();
  renderPatientBanner(document.getElementById("patientBanner"), patientId);
  const orderId = getParam("order") || "(unknown)";
  document.getElementById("orderConfirmation").innerHTML = `
    <p>Order <strong data-testid="order-id">${orderId}</strong> confirmed.</p>
    <p>Payment and order creation completed as a single atomic step — no charge exists without a matching order record, and vice versa.</p>
    <a class="primary" href="history.html?patient=${patientId}" data-testid="view-history-link">View order history</a>
  `;
}

// ---------------------------------------------------------------------------
// history.html — per-patient isolation (TC-09)
// ---------------------------------------------------------------------------
function initHistoryPage() {
  seedOrderHistory();
  const patientId = currentPatientId();
  const patient = PATIENTS[patientId];
  renderPatientBanner(document.getElementById("patientBanner"), patientId);

  document.getElementById("allergyRecord").innerHTML = `
    <div data-testid="allergy-record">Allergy record: ${patient.allergy ? `Documented ${patient.allergy} allergy` : "No documented allergies"}</div>
  `;

  const orders = getOrders(patientId);
  document.getElementById("orderHistory").innerHTML = `
    <div data-testid="order-history">
      ${orders.map(o => `
        <div class="order-item" data-testid="order-item-${o.id}">
          <span class="oid">${o.id}</span> — ${o.med} — ${money(o.total)} — ${o.date}
        </div>
      `).join("") || "<p>No orders yet.</p>"}
    </div>
  `;

  const requestedOrder = getParam("order");
  if (requestedOrder) {
    const found = orders.some(o => o.id === requestedOrder);
    if (!found) {
      document.getElementById("accessCheck").innerHTML = `
        <div class="block-message" data-testid="access-denied-message">
          Access denied. Order ${requestedOrder} does not belong to ${patient.name}.
        </div>
      `;
    } else {
      document.getElementById("accessCheck").innerHTML = `
        <div class="note-message" data-testid="access-granted-message">Showing ${requestedOrder} — belongs to ${patient.name}.</div>
      `;
    }
  }

  const otherId = Object.keys(PATIENTS).find(id => id !== patientId);
  const otherOrders = getOrders(otherId);
  document.getElementById("isolationDemoNote").innerHTML = otherOrders.length ? `
    <div class="demo-note">
      Isolation demo: try <code>?patient=${patientId}&amp;order=${otherOrders[0].id}</code> in the
      address bar — that order belongs to Patient ${otherId.toUpperCase()}, so it's denied here.
    </div>
  ` : "";
}

document.addEventListener("DOMContentLoaded", () => {
  if (document.getElementById("medicationList")) initIndexPage();
  else if (document.getElementById("payButton")) initReviewPage();
  else if (document.getElementById("orderConfirmation")) initConfirmationPage();
  else if (document.getElementById("orderHistory")) initHistoryPage();
});
