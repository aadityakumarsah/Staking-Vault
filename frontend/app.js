const YEAR = 31_536_000;
const DAY = 86_400;
const RATE_BPS = 1_000;
const MAX_INPUT = 100_000_000;
const STORAGE_KEY = "vaultlab-contract-state-v3";
const baseDate = new Date(Date.UTC(2026, 0, 1));

const formatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
let positionFilter = "all";
let toastTimer;

function defaultState() {
  return {
    active: "alice",
    now: 0,
    wallets: { admin: 1_000_000, alice: 10_000, bob: 10_000 },
    vaultBalance: 0,
    rewardBalance: 0,
    reservedRewards: 0,
    principalLiability: 0,
    positions: [],
    events: [],
    nextId: 1,
  };
}

function loadState() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    if (saved && saved.wallets && Array.isArray(saved.positions) && Array.isArray(saved.events)) {
      return { ...defaultState(), ...saved };
    }
  } catch {
    // Invalid browser storage is safely replaced with a fresh simulator state.
  }
  return defaultState();
}

let state = loadState();

function persist() {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function formatTokens(amount) {
  return `${formatter.format(Math.max(0, Math.floor(Number(amount) || 0)))} TOK`;
}

function accountName(account) {
  return account ? account[0].toUpperCase() + account.slice(1) : "Unknown";
}

function dayCount(seconds) {
  return Math.max(0, Math.floor(seconds / DAY));
}

function dateFor(seconds) {
  return new Date(baseDate.getTime() + seconds * 1000);
}

function formatDate(seconds) {
  return dateFor(seconds).toLocaleDateString("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function simulatedDateLabel() {
  return `Day ${dayCount(state.now)} · ${formatDate(state.now)}`;
}

function rewardForTerm(principal, lockSeconds) {
  const annualReward = Math.floor((principal * RATE_BPS) / 10_000);
  return Math.floor((annualReward * lockSeconds) / YEAR);
}

function vestedReward(position) {
  const elapsed = Math.max(0, Math.min(state.now - position.createdAt, position.lockSeconds));
  return Math.floor((position.totalReward * elapsed) / position.lockSeconds);
}

function claimable(position) {
  return Math.max(0, vestedReward(position) - position.rewardPaid);
}

function maturityAt(position) {
  return position.createdAt + position.lockSeconds;
}

function positionProgress(position) {
  return Math.max(0, Math.min(100, Math.floor(((state.now - position.createdAt) / position.lockSeconds) * 100)));
}

function availableRewards() {
  return state.rewardBalance - state.reservedRewards;
}

function totalClaimable() {
  return state.positions.reduce((total, position) => total + claimable(position), 0);
}

function addEvent(type, title, detail) {
  state.events.unshift({ type, title, detail, at: state.now, id: `${state.now}-${state.events.length + 1}` });
}

function saveAndRender() {
  persist();
  render();
}

function notify(message, isError = false) {
  const toast = document.querySelector("[data-toast]");
  if (!toast) return;
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3600);
}

function setText(selector, value) {
  document.querySelectorAll(selector).forEach((node) => {
    node.textContent = value;
  });
}

function activeWalletBalance() {
  return state.wallets[state.active];
}

function readAmount(input, label) {
  const amount = Number(input.value);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_INPUT) {
    notify(`${label} must be a whole number between 1 and ${formatter.format(MAX_INPUT)} TOK.`, true);
    return null;
  }
  return amount;
}

function resetSimulator() {
  state = defaultState();
  positionFilter = "all";
  saveAndRender();
  notify("Local test data has been reset.");
}

function changeAccount(account) {
  if (!["alice", "bob"].includes(account)) return;
  state.active = account;
  saveAndRender();
}

function advanceTime(seconds) {
  state.now = Math.max(0, Math.min(YEAR * 3, Math.round((state.now + seconds) / DAY) * DAY));
  saveAndRender();
  notify(`Chain time advanced to ${simulatedDateLabel()}.`);
}

function setTime(days) {
  state.now = Math.max(0, Math.min(YEAR * 3, Math.round(days) * DAY));
  saveAndRender();
}

function fundRewards(amount) {
  if (state.wallets.admin < amount) {
    notify("The administrator wallet does not have enough TOK.", true);
    return;
  }
  state.wallets.admin -= amount;
  state.vaultBalance += amount;
  state.rewardBalance += amount;
  addEvent("fund", "Reward pool funded", `Administrator deposited ${formatTokens(amount)}.`);
  saveAndRender();
  notify(`${formatTokens(amount)} added to the reward reserve.`);
}

function createStake(amount, lockSeconds) {
  if (activeWalletBalance() < amount) {
    notify(`${accountName(state.active)} does not have enough TOK for this position.`, true);
    return;
  }
  const reward = rewardForTerm(amount, lockSeconds);
  if (state.reservedRewards + reward > state.rewardBalance) {
    notify(`The reward reserve cannot collateralize ${formatTokens(reward)}. Fund it before staking.`, true);
    return;
  }
  const position = {
    id: state.nextId,
    owner: state.active,
    principal: amount,
    createdAt: state.now,
    lockSeconds,
    totalReward: reward,
    rewardPaid: 0,
  };
  state.nextId += 1;
  state.wallets[state.active] -= amount;
  state.vaultBalance += amount;
  state.principalLiability += amount;
  state.reservedRewards += reward;
  state.positions.unshift(position);
  addEvent("stake", "Stake created", `${accountName(position.owner)} locked ${formatTokens(amount)} for ${dayCount(lockSeconds)} days.`);
  saveAndRender();
  notify(`Position #${position.id} created with ${formatTokens(reward)} fully reserved.`);
  window.setTimeout(() => {
    if (document.body.dataset.page === "stake") window.location.assign("./positions.html");
  }, 650);
}

function claimRewards(id) {
  const position = state.positions.find((item) => item.id === id);
  if (!position || position.owner !== state.active) {
    notify("Switch to the position owner's test account to claim rewards.", true);
    return;
  }
  const amount = claimable(position);
  if (!amount) {
    notify("No new rewards have vested at this chain time.", true);
    return;
  }
  position.rewardPaid += amount;
  state.wallets[position.owner] += amount;
  state.vaultBalance -= amount;
  state.rewardBalance -= amount;
  state.reservedRewards -= amount;
  addEvent("claim", "Rewards claimed", `${accountName(position.owner)} claimed ${formatTokens(amount)} from position #${id}.`);
  saveAndRender();
  notify(`${formatTokens(amount)} transferred to ${accountName(position.owner)}.`);
}

function withdrawPosition(id) {
  const index = state.positions.findIndex((item) => item.id === id);
  const position = state.positions[index];
  if (!position || position.owner !== state.active) {
    notify("Switch to the position owner's test account to withdraw principal.", true);
    return;
  }
  if (state.now < maturityAt(position)) {
    notify(`Principal is still locked for ${dayCount(maturityAt(position) - state.now)} days.`, true);
    return;
  }
  const finalReward = claimable(position);
  const payout = position.principal + finalReward;
  state.wallets[position.owner] += payout;
  state.vaultBalance -= payout;
  state.principalLiability -= position.principal;
  state.rewardBalance -= finalReward;
  state.reservedRewards -= position.totalReward - position.rewardPaid;
  state.positions.splice(index, 1);
  if (finalReward) addEvent("claim", "Final rewards claimed", `${formatTokens(finalReward)} paid from position #${id}.`);
  addEvent("withdraw", "Principal withdrawn", `${accountName(position.owner)} withdrew ${formatTokens(position.principal)} from position #${id}.`);
  saveAndRender();
  notify(`Position #${id} closed. ${formatTokens(payout)} returned to ${accountName(position.owner)}.`);
}

function loadScenario() {
  state = defaultState();
  const funding = 10_000;
  const principal = 1_500;
  const term = YEAR * 1.5;
  const reward = rewardForTerm(principal, term);
  state.wallets.admin -= funding;
  state.vaultBalance += funding;
  state.rewardBalance += funding;
  addEvent("fund", "Reward pool funded", "Administrator deposited 10,000 TOK.");
  state.wallets.alice -= principal;
  state.vaultBalance += principal;
  state.principalLiability += principal;
  state.reservedRewards += reward;
  state.positions.push({ id: state.nextId, owner: "alice", principal, createdAt: 0, lockSeconds: term, totalReward: reward, rewardPaid: 0 });
  state.nextId += 1;
  addEvent("stake", "Stake created", "Alice locked 1,500 TOK for 547 days.");
  state.now = Math.round((term / 2) / DAY) * DAY;
  saveAndRender();
  notify("Sample scenario loaded at the halfway point of a 1.5-year position.");
}

function emptyRow(columns, message) {
  return `<tr><td colspan="${columns}"><div class="empty-table"><strong>No positions yet</strong><span>Create a stake or load the sample flow to begin testing.</span></div></td></tr>`;
}

function renderOverviewPositions() {
  const target = document.querySelector("[data-overview-positions]");
  if (!target) return;
  if (!state.positions.length) {
    target.innerHTML = emptyRow(4, "No positions yet");
    return;
  }
  target.innerHTML = state.positions.slice(0, 4).map((position) => {
    const matured = state.now >= maturityAt(position);
    return `<tr><td><b>#${position.id}</b><small>${accountName(position.owner)}</small></td><td>${formatTokens(position.principal)}</td><td class="positive">${formatTokens(claimable(position))}</td><td><span class="status ${matured ? "matured" : "active"}">${matured ? "Matured" : `${dayCount(maturityAt(position) - state.now)}d left`}</span></td></tr>`;
  }).join("");
}

function renderPositionsTable() {
  const target = document.querySelector("[data-positions-table]");
  if (!target) return;
  const positions = state.positions.filter((position) => {
    if (positionFilter === "active") return state.now < maturityAt(position);
    if (positionFilter === "matured") return state.now >= maturityAt(position);
    return true;
  });
  if (!positions.length) {
    target.innerHTML = emptyRow(7, "No matching positions");
    return;
  }
  target.innerHTML = positions.map((position) => {
    const matured = state.now >= maturityAt(position);
    const canAct = state.active === position.owner;
    const available = claimable(position);
    return `<tr><td><b>#${position.id}</b><small>${accountName(position.owner)}</small></td><td>${formatTokens(position.principal)}</td><td>${dayCount(position.lockSeconds)} days</td><td><div class="progress-cell"><span>${positionProgress(position)}%</span><i><b style="width:${positionProgress(position)}%"></b></i></div></td><td class="positive">${formatTokens(available)}</td><td><span class="status ${matured ? "matured" : "active"}">${matured ? "Matured" : "Locked"}</span></td><td><div class="row-actions"><button class="table-button" type="button" data-action="claim" data-id="${position.id}" ${!canAct || !available ? "disabled" : ""}>Claim</button><button class="table-button primary-table-button" type="button" data-action="withdraw" data-id="${position.id}" ${!canAct || !matured ? "disabled" : ""}>Withdraw</button></div></td></tr>`;
  }).join("");
}

function eventMarkup(events, compact = false) {
  if (!events.length) return `<div class="empty-events"><strong>No contract activity</strong><span>Events will appear as you fund, stake, claim, and withdraw.</span></div>`;
  const label = { fund: "Funding", stake: "Stake", claim: "Claim", withdraw: "Withdrawal" };
  return events.map((event) => `<div class="event-row ${compact ? "compact-event" : ""}"><span class="event-type ${event.type}">${label[event.type]}</span><div><strong>${event.title}</strong><p>${event.detail}</p></div><time>Day ${dayCount(event.at)}<small>${formatDate(event.at)}</small></time></div>`).join("");
}

function renderEvents() {
  const recent = document.querySelector("[data-recent-events]");
  if (recent) recent.innerHTML = eventMarkup(state.events.slice(0, 4), true);
  const activity = document.querySelector("[data-activity-list]");
  if (activity) activity.innerHTML = eventMarkup(state.events);
  setText("[data-event-count]", `${state.events.length} event${state.events.length === 1 ? "" : "s"}`);
}

function renderStakePreview() {
  const form = document.querySelector("[data-stake-form]");
  if (!form) return;
  const amount = Math.max(0, Math.min(MAX_INPUT, Number(form.elements.amount.value) || 0));
  const selected = form.querySelector('input[name="term"]:checked');
  const term = Number(selected?.value || YEAR);
  const reward = rewardForTerm(amount, term);
  const available = availableRewards();
  setText("[data-stake-reward]", formatTokens(reward));
  setText("[data-stake-maturity]", `${dayCount(term)} days from today`);
  setText("[data-stake-total]", formatTokens(amount + reward));
  setText("[data-stake-collateral]", available >= reward ? `${formatTokens(reward)} can be fully reserved from ${formatTokens(available)} currently available.` : `${formatTokens(reward - available)} more TOK must be funded before this position can be accepted.`);
}

function render() {
  const active = accountName(state.active);
  const held = state.vaultBalance;
  const expectedHeld = state.principalLiability + state.rewardBalance;
  const invariantHolds = held === expectedHeld && state.reservedRewards <= state.rewardBalance;
  setText("[data-wallet-balance]", formatTokens(activeWalletBalance()));
  setText("[data-active-account]", active);
  setText("[data-vault-balance]", formatTokens(state.vaultBalance));
  setText("[data-available-rewards]", formatTokens(availableRewards()));
  setText("[data-reserved-rewards]", formatTokens(state.reservedRewards));
  setText("[data-principal-liability]", formatTokens(state.principalLiability));
  setText("[data-total-claimable]", formatTokens(totalClaimable()));
  setText("[data-simulated-date]", simulatedDateLabel());
  setText("[data-current-day]", `Day ${dayCount(state.now)}`);
  setText("[data-position-count]", state.positions.length);
  setText("[data-collateral-status]", invariantHolds ? "Ready" : "Review state");
  setText("[data-reserve-ratio]", invariantHolds ? "Reward reserve is fully funded" : "A simulator invariant needs attention");
  setText("[data-coverage-value]", `${formatTokens(held)} covered`);
  document.querySelectorAll("[data-account-select]").forEach((select) => { select.value = state.active; });
  document.querySelectorAll("[data-avatar]").forEach((button) => { button.textContent = active.slice(0, 1); });
  document.querySelectorAll("[data-time-slider]").forEach((slider) => { slider.value = Math.min(1095, dayCount(state.now)); });
  document.querySelectorAll("[data-invariant-status]").forEach((node) => { node.classList.toggle("failed", !invariantHolds); node.innerHTML = `<span></span> ${invariantHolds ? "Invariant holds" : "Invariant failed"}`; });
  document.querySelectorAll("[data-position-filter]").forEach((button) => button.classList.toggle("active", button.dataset.positionFilter === positionFilter));
  renderOverviewPositions();
  renderPositionsTable();
  renderEvents();
  renderStakePreview();
}

function exportState() {
  const file = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const href = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `vaultlab-state-day-${dayCount(state.now)}.json`;
  anchor.click();
  URL.revokeObjectURL(href);
  notify("Current test state exported as JSON.");
}

document.addEventListener("change", (event) => {
  if (event.target.matches("[data-account-select]")) changeAccount(event.target.value);
  if (event.target.matches("[data-time-slider]")) setTime(Number(event.target.value));
  if (event.target.matches('[data-stake-form] input[name="term"]')) renderStakePreview();
});

document.addEventListener("input", (event) => {
  if (event.target.matches('[data-stake-form] input[name="amount"]')) renderStakePreview();
});

document.addEventListener("submit", (event) => {
  if (event.target.matches("[data-fund-form]")) {
    event.preventDefault();
    const amount = readAmount(event.target.elements.amount, "Funding amount");
    if (amount) fundRewards(amount);
  }
  if (event.target.matches("[data-stake-form]")) {
    event.preventDefault();
    const amount = readAmount(event.target.elements.amount, "Principal amount");
    const term = Number(event.target.querySelector('input[name="term"]:checked')?.value);
    if (amount && term) createStake(amount, term);
  }
});

document.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]");
  if (action) {
    const id = Number(action.dataset.id);
    if (action.dataset.action === "claim") claimRewards(id);
    if (action.dataset.action === "withdraw") withdrawPosition(id);
  }
  const advance = event.target.closest("[data-advance]");
  if (advance) advanceTime(Number(advance.dataset.advance));
  if (event.target.closest("[data-reset]")) resetSimulator();
  if (event.target.closest("[data-load-scenario]")) loadScenario();
  if (event.target.closest("[data-export]")) exportState();
  const filter = event.target.closest("[data-position-filter]");
  if (filter) { positionFilter = filter.dataset.positionFilter; render(); }
});

render();
