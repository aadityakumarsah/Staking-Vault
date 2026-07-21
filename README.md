# VaultLab — Linear Staking Vault

A full-stack-style staking product prototype: a deterministic Rust vault engine
and a professional, multi-route browser console for safely testing its flows.

**Live demo:** [aadityakumarsah.github.io/Staking-Vault](https://aadityakumarsah.github.io/Staking-Vault/)

> This project is a local simulator and contract domain model. It does not
> connect to a wallet, custody real tokens, or deploy to a public blockchain.

## Problem

Fixed-term staking products look simple, but their core rules are easy to get
wrong:

- Reward formulas can become inconsistent for partial-year terms such as 1.5 years.
- A vault can promise more rewards than it has funds to pay.
- Floating-point arithmetic is unsafe for token balances.
- Users need a clear, testable view of when rewards can be claimed and when
  principal can be withdrawn.
- Smart-contract logic is difficult to explain without an interactive product
  experience.

## Solution

VaultLab implements a collateralized, fixed-term staking design with linear
rewards and an interactive test console.

When a user creates a position, the vault calculates the maximum reward for the
chosen term and reserves it immediately. A stake is rejected if the reward pool
cannot cover that commitment. Rewards vest continuously, while principal stays
locked until maturity.

At a 10% annual reward rate, the model behaves as follows:

| Lock term | Total reward at maturity | Reward on 1,000 TOK |
| --- | ---: | ---: |
| 1 year | 1.0× annual reward | 100 TOK |
| 1.5 years | 1.5× annual reward | 150 TOK |
| 2 years | 2.0× annual reward | 200 TOK |

```text
maximum reward = principal × annual_reward_bps / 10,000 × lock_seconds / 31,536,000
vested reward = maximum reward × min(elapsed, lock_seconds) / lock_seconds
claimable      = vested reward − previously claimed reward
```

## Why use VaultLab?

- **Clear reward economics** — the return grows linearly with the selected term.
- **Full reward collateralization** — new stakes cannot over-commit the reserve.
- **Safe accounting model** — Rust uses checked `u128` arithmetic; no floating point.
- **Deterministic testing** — time is passed into the vault, making edge cases reproducible.
- **Professional product demo** — the frontend makes the contract flow easy to present to recruiters, reviewers, and stakeholders.
- **No setup for a demo** — the hosted UI uses a local test state and never asks for a wallet.

## How to use the app

### Option 1: Open the hosted app

1. Open [VaultLab](https://aadityakumarsah.github.io/Staking-Vault/).
2. On **Overview**, inspect the active wallet, vault balance, available rewards,
   and collateral status.
3. Open **Create stake** from the sidebar.
4. In **Fund rewards**, add TOK to the reward pool as the simulated administrator.
5. Enter a principal amount, choose a 1-year, 1.5-year, or 2-year lock term,
   and confirm that the collateral preview is funded.
6. Select **Reserve rewards and create stake**.
7. Open **Positions** to inspect vesting progress and claimable rewards.
8. Advance simulated time with the quick controls. Claim vested rewards when
   available; after maturity, withdraw the principal plus any remaining reward.
9. Open **Activity** to review every state transition, move the time slider,
   export the current state as JSON, or reset the local test session.

The test state persists in browser local storage, so it remains available while
you move between routes. Use **Reset local data** at any time to start fresh.

### Option 2: Run the frontend locally

```bash
git clone https://github.com/aadityakumarsah/Staking-Vault.git
cd Staking-Vault
python3 -m http.server 4173 --directory frontend
```

Open [http://localhost:4173](http://localhost:4173) in a browser.

### Run the Rust vault engine

Install the stable [Rust toolchain](https://www.rust-lang.org/tools/install),
then run:

```bash
cargo test
cargo run
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

`cargo run` demonstrates a 1.5-year position with a mid-term reward claim and
a maturity withdrawal. `cargo test` verifies the financial rules and failure
paths.

## Product routes

| Route | Purpose |
| --- | --- |
| [Overview](https://aadityakumarsah.github.io/Staking-Vault/) | Vault health, reserve status, open positions, and recent events |
| [Create stake](https://aadityakumarsah.github.io/Staking-Vault/stake.html) | Fund rewards, configure a term, and create a collateralized position |
| [Positions](https://aadityakumarsah.github.io/Staking-Vault/positions.html) | View vesting, claim rewards, withdraw matured principal, and advance time |
| [Activity](https://aadityakumarsah.github.io/Staking-Vault/activity.html) | Inspect the audit trail, export state, and run the 1.5-year sample scenario |

## Tech stack

| Layer | Technology | Purpose |
| --- | --- | --- |
| Contract domain | Rust 2021 | Deterministic staking rules and token accounting |
| Financial types | Native `u128`, checked arithmetic | Exact token-unit calculations without floating point |
| Frontend | HTML5, modern CSS, vanilla JavaScript modules | Dependency-free responsive product console |
| Browser state | `localStorage` | Shared test wallets, clock, positions, and events across routes |
| Testing & quality | Rust tests, `rustfmt`, Clippy | Unit tests, formatting, and lint enforcement |
| CI/CD | GitHub Actions | Runs formatting, Clippy, and all Rust tests on every push |
| Hosting | GitHub Pages | Publishes the static frontend automatically from `main` |

## Architecture

```text
┌──────────────────────────────┐
│  Browser test console        │
│  HTML + CSS + JavaScript     │
│  Local storage test state    │
└──────────────┬───────────────┘
               │ mirrors the same business rules
┌──────────────▼───────────────┐
│  Rust staking vault engine   │
│  Positions · rewards · auth  │
│  Reservation · invariants    │
└──────────────────────────────┘
```

The frontend is intentionally a safe simulator, not a direct runtime adapter
for the Rust library. The Rust unit tests are the source of truth for contract
behavior. A production integration would replace the browser state with a
blockchain runtime or API adapter.

## Core rules and safeguards

- Positions have immutable owner, principal, creation time, and lock duration.
- Only the administrator can fund rewards.
- Only the position owner can claim rewards or withdraw principal.
- Principal is unavailable before maturity.
- Rewards vest linearly and can be claimed in multiple transactions.
- The entire unclaimed reward entitlement is reserved at stake creation.
- The vault maintains the invariant:

```text
vault balance = outstanding principal liability + reward balance
reserved rewards ≤ reward balance
```

## Where it can be used

VaultLab is useful as:

- A **DeFi / staking product prototype** before choosing a chain runtime.
- A **portfolio project** demonstrating Rust financial logic, testing, CI/CD,
  and product-focused frontend design.
- A **QA sandbox** for manually walking through funding, staking, vesting,
  claiming, and maturity edge cases.
- A **teaching tool** for explaining collateralization and time-based reward
  calculations without exposing users to real funds.
- A starting point for a **CosmWasm, Solana, or EVM adapter** after replacing
  the in-memory ledger with chain-native storage, transfers, identity, and time.

## Project structure

```text
.
├── src/
│   ├── lib.rs                  # Staking-vault domain model and tests
│   └── main.rs                 # Runnable Rust demonstration
├── frontend/
│   ├── index.html              # Overview route
│   ├── stake.html              # Create-stake route
│   ├── positions.html          # Position operations route
│   ├── activity.html           # Audit and simulation route
│   ├── app.js                  # Shared persistent simulator state
│   └── styles.css              # Responsive professional UI system
└── .github/workflows/
    ├── ci.yml                  # Rust quality checks
    └── deploy-frontend.yml     # GitHub Pages deployment
```

## Production notes

Before using this design with real assets, add a chain-specific token adapter,
persistent on-chain storage, native caller identity, chain time, governance and
emergency controls, token-decimal handling, integration tests, and an
independent security audit.

## Resume description

> Built a Rust staking-vault domain engine with linearly vested fixed-term
> rewards, reward-pool collateralization, checked `u128` accounting,
> authorization boundaries, audit events, and automated CI. Delivered a
> responsive multi-route test console on GitHub Pages for safely demonstrating
> funding, staking, vesting, claims, and withdrawals.
