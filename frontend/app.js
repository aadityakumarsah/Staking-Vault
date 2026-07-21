const YEAR = 31_536_000;
const DAY = 86_400;
const RATE_BPS = 1_000;
const MAX_INPUT = 100_000_000;
const baseDate = new Date(Date.UTC(2026, 0, 1));

let state;
let selectedTerm = YEAR;
let toastTimer;

const dollars = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const elements = {
  account: document.querySelector("#account-select"),
  avatar: document.querySelector("#account-avatar"),
  activeWalletName: document.querySelector("#active-wallet-name"),
  walletBalance: document.querySelector("#wallet-balance"),
  vaultBalance: document.querySelector("#vault-balance"),
  rewardBalance: document.querySelector("#reward-balance"),
  reservedRewards: document.querySelector("#reserved-rewards"),
  availableRewards: document.querySelector("#available-rewards"),
  stakeAvailable: document.querySelector("#stake-available"),
  stakeAmount: document.querySelector("#stake-amount"),
  projectedReward: document.querySelector("#projected-reward"),
  projectionMaturity: document.querySelector("#projection-maturity"),
  positions: document.querySelector("#positions-list"),
  events: document.querySelector("#event-list"),
  eventCount: document.querySelector("#event-count"),
  date: document.querySelector("#simulated-date"),
  timelineValue: document.querySelector("#timeline-value"),
  slider: document.querySelector("#time-slider"),
  toast: document.querySelector("#toast"),
  fundAmount: document.querySelector("#fund-amount"),
};

function resetState() {
  state = {
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

function formatTokens(amount) {
  return `${dollars.format(Math.max(0, Math.floor(amount)))} TOK`;
}

function displayName(account) {
  return account[0].toUpperCase() + account.slice(1);
}

function dateAt(seconds) {
  return new Date(baseDate.getTime() + seconds * 1000);
}

function humanDate(seconds) {
  return dateAt(seconds).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
}

function totalReward(principal, lockSeconds) {
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

function daysFor(seconds) {
  return Math.floor(seconds / DAY);
}

function addEvent(type, title, detail) {
  state.events.unshift({ type, title, detail, at: state.now });
}

function notify(message, error = false) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast show${error ? " error" : ""}`;
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("show"), 3500);
}

function readPositiveInteger(input, fieldName) {
  const amount = Number(input.value);
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_INPUT) {
    notify(`${fieldName} must be a whole number between 1 and ${dollars.format(MAX_INPUT)}.`, true);
    return null;
  }
  return amount;
}

function renderPositions() {
  if (!state.positions.length) {
    elements.positions.innerHTML = `
      <div class="empty-state">
        <span>◇</span>
        <strong>No active positions yet</strong>
        <small>Fund the reward pool, then create a stake to test the contract flow.</small>
      </div>`;
    return;
  }

  elements.positions.innerHTML = state.positions
    .map((position) => {
      const progress = Math.min(100, Math.floor(((state.now - position.createdAt) / position.lockSeconds) * 100));
      const matured = state.now >= position.createdAt + position.lockSeconds;
      const canAct = state.active === position.owner;
      const available = claimable(position);
      const remainingDays = Math.max(0, daysFor(position.createdAt + position.lockSeconds - state.now));
      return `
        <article class="position">
          <div class="position-top">
            <div class="position-owner">
              <span class="avatar">${position.owner[0].toUpperCase()}</span>
              <div><strong>${displayName(position.owner)} · #${position.id}</strong><small>${formatTokens(position.principal)} locked · ${daysFor(position.lockSeconds)} days</small></div>
            </div>
            <div class="position-reward"><span>Claimable</span><strong>${formatTokens(available)}</strong></div>
          </div>
          <div class="position-progress"><i style="width: ${Math.max(0, progress)}%"></i></div>
          <div class="position-bottom">
            <span>${matured ? "Matured — ready to withdraw" : `${remainingDays} days until maturity`}</span>
            <div class="position-actions">
              <button class="mini-button" type="button" data-action="claim" data-id="${position.id}" ${!canAct || !available ? "disabled" : ""}>Claim</button>
              <button class="mini-button" type="button" data-action="withdraw" data-id="${position.id}" ${!canAct || !matured ? "disabled" : ""}>Withdraw</button>
            </div>
          </div>
        </article>`;
    })
    .join("");
}

function renderEvents() {
  elements.eventCount.textContent = `${state.events.length} event${state.events.length === 1 ? "" : "s"}`;
  if (!state.events.length) {
    elements.events.innerHTML = '<div class="event-empty">Your simulated contract activity will appear here.</div>';
    return;
  }
  const icons = { fund: "✦", stake: "＋", claim: "↙", withdraw: "↗" };
  elements.events.innerHTML = state.events
    .slice(0, 5)
    .map(
      (event) => `
      <div class="event">
        <span class="event-icon ${event.type}">${icons[event.type]}</span>
        <div><strong>${event.title}</strong><small>${event.detail}</small></div>
        <time>Day ${daysFor(event.at)}</time>
      </div>`
    )
    .join("");
}

function render() {
  const active = state.active;
  const rawAmount = Number(elements.stakeAmount.value);
  const amount = Number.isFinite(rawAmount)
    ? Math.max(0, Math.min(MAX_INPUT, rawAmount))
    : 0;
  const reward = totalReward(amount, selectedTerm);
  const currentDate = humanDate(state.now);
  const timelineDays = Math.round(state.now / DAY);

  elements.avatar.textContent = active[0].toUpperCase();
  elements.activeWalletName.textContent = displayName(active);
  elements.walletBalance.textContent = formatTokens(state.wallets[active]);
  elements.vaultBalance.textContent = formatTokens(state.vaultBalance);
  elements.rewardBalance.textContent = formatTokens(state.rewardBalance);
  elements.reservedRewards.textContent = formatTokens(state.reservedRewards);
  elements.availableRewards.textContent = `${formatTokens(state.rewardBalance - state.reservedRewards)} available`;
  elements.stakeAvailable.textContent = formatTokens(state.wallets[active]);
  elements.projectedReward.textContent = formatTokens(reward);
  elements.projectionMaturity.textContent = `Matures in ${daysFor(selectedTerm)} days`;
  elements.date.textContent = `Day ${timelineDays} · ${currentDate}`;
  elements.timelineValue.textContent = `${timelineDays} day${timelineDays === 1 ? "" : "s"}`;
  elements.slider.value = Math.min(1095, timelineDays);

  document.querySelectorAll(".term-option").forEach((button) => {
    button.classList.toggle("selected", Number(button.dataset.term) === selectedTerm);
  });
  renderPositions();
  renderEvents();
}

function fundRewards() {
  const amount = readPositiveInteger(elements.fundAmount, "Funding amount");
  if (!amount) return;
  if (state.wallets.admin < amount) {
    notify("Admin wallet does not have enough TOK.", true);
    return;
  }
  state.wallets.admin -= amount;
  state.vaultBalance += amount;
  state.rewardBalance += amount;
  addEvent("fund", "Reward pool funded", `Admin added ${formatTokens(amount)}`);
  notify(`Reward pool funded with ${formatTokens(amount)}.`);
  render();
}

function createStake() {
  const amount = readPositiveInteger(elements.stakeAmount, "Stake amount");
  if (!amount) return;
  if (state.wallets[state.active] < amount) {
    notify(`${displayName(state.active)} does not have enough TOK.`, true);
    return;
  }
  const reward = totalReward(amount, selectedTerm);
  if (state.reservedRewards + reward > state.rewardBalance) {
    notify(`Reward pool cannot collateralize ${formatTokens(reward)} for this stake. Fund it first.`, true);
    return;
  }
  const position = {
    id: state.nextId++,
    owner: state.active,
    principal: amount,
    createdAt: state.now,
    lockSeconds: selectedTerm,
    totalReward: reward,
    rewardPaid: 0,
  };
  state.wallets[state.active] -= amount;
  state.vaultBalance += amount;
  state.principalLiability += amount;
  state.reservedRewards += reward;
  state.positions.unshift(position);
  addEvent("stake", "Stake created", `${displayName(state.active)} locked ${formatTokens(amount)} for ${daysFor(selectedTerm)} days`);
  notify(`Position #${position.id} created — ${formatTokens(reward)} fully reserved.`);
  render();
}

function claimRewards(id) {
  const position = state.positions.find((item) => item.id === id);
  if (!position || position.owner !== state.active) {
    notify("Only the position owner can claim rewards.", true);
    return;
  }
  const amount = claimable(position);
  if (!amount) {
    notify("No newly vested rewards are available yet.", true);
    return;
  }
  position.rewardPaid += amount;
  state.wallets[position.owner] += amount;
  state.vaultBalance -= amount;
  state.rewardBalance -= amount;
  state.reservedRewards -= amount;
  addEvent("claim", "Rewards claimed", `${displayName(position.owner)} claimed ${formatTokens(amount)} from #${position.id}`);
  notify(`${formatTokens(amount)} claimed to ${displayName(position.owner)}'s wallet.`);
  render();
}

function withdraw(id) {
  const index = state.positions.findIndex((item) => item.id === id);
  const position = state.positions[index];
  if (!position || position.owner !== state.active) {
    notify("Only the position owner can withdraw principal.", true);
    return;
  }
  if (state.now < position.createdAt + position.lockSeconds) {
    notify(`Principal stays locked for ${daysFor(position.createdAt + position.lockSeconds - state.now)} more days.`, true);
    return;
  }
  const reward = claimable(position);
  const payout = position.principal + reward;
  state.wallets[position.owner] += payout;
  state.vaultBalance -= payout;
  state.principalLiability -= position.principal;
  state.rewardBalance -= reward;
  state.reservedRewards -= position.totalReward - position.rewardPaid;
  state.positions.splice(index, 1);
  if (reward) addEvent("claim", "Final rewards claimed", `${formatTokens(reward)} paid from #${position.id}`);
  addEvent("withdraw", "Principal withdrawn", `${displayName(position.owner)} withdrew ${formatTokens(position.principal)}`);
  notify(`Position #${position.id} closed — ${formatTokens(payout)} returned.`);
  render();
}

function setClock(seconds) {
  state.now = Math.max(0, Math.min(YEAR * 3, Math.round(seconds / DAY) * DAY));
  render();
}

function runScenario() {
  resetState();
  selectedTerm = YEAR * 1.5;
  elements.account.value = "alice";
  elements.stakeAmount.value = "1500";
  state.wallets.admin -= 10_000;
  state.vaultBalance += 10_000;
  state.rewardBalance += 10_000;
  addEvent("fund", "Reward pool funded", "Admin added 10,000 TOK");
  const reward = totalReward(1_500, selectedTerm);
  state.wallets.alice -= 1_500;
  state.vaultBalance += 1_500;
  state.principalLiability += 1_500;
  state.reservedRewards += reward;
  state.positions.unshift({
    id: state.nextId++,
    owner: "alice",
    principal: 1_500,
    createdAt: 0,
    lockSeconds: selectedTerm,
    totalReward: reward,
    rewardPaid: 0,
  });
  addEvent("stake", "Stake created", "Alice locked 1,500 TOK for 547 days");
  setClock(selectedTerm / 2);
  notify("Loaded: a 1.5-year stake halfway through its term.");
}

document.querySelector("#fund-button").addEventListener("click", fundRewards);
document.querySelector("#stake-button").addEventListener("click", createStake);
document.querySelector("#reset-button").addEventListener("click", () => {
  resetState();
  selectedTerm = YEAR;
  elements.account.value = "alice";
  elements.stakeAmount.value = "1000";
  notify("Test session reset.");
  render();
});
document.querySelector("#scenario-button").addEventListener("click", runScenario);
elements.account.addEventListener("change", (event) => {
  state.active = event.target.value;
  render();
});
elements.stakeAmount.addEventListener("input", render);
elements.slider.addEventListener("input", (event) => setClock(Number(event.target.value) * DAY));
document.querySelectorAll(".term-option").forEach((button) => {
  button.addEventListener("click", () => {
    selectedTerm = Number(button.dataset.term);
    render();
  });
});
document.querySelectorAll(".time-button").forEach((button) => {
  button.addEventListener("click", () => setClock(state.now + Number(button.dataset.advance)));
});
elements.positions.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = Number(button.dataset.id);
  if (button.dataset.action === "claim") claimRewards(id);
  if (button.dataset.action === "withdraw") withdraw(id);
});

resetState();
render();
