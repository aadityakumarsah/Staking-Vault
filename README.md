# Linear Staking Vault

A polished Rust portfolio project that models the core of a collateralized, fixed-term staking smart contract. It uses no external dependencies, so the reward math and state transitions are fast to test and easy to audit.

## Why this project

For a short build window, a staking vault shows more engineering depth than a basic temporary-email service: deterministic financial calculations, authorization, value custody, solvency guarantees, immutable positions, and adversarial tests. The domain layer is chain-agnostic by design, making it portable to a real contract runtime.

## Reward design

The reward grows linearly with the selected lock term. With an annual reward rate of **10%**:

| Lock term | Total return at maturity | Reward on 1,000 tokens |
| --- | ---: | ---: |
| 1 year | 1.0× annual reward | 100 |
| 1.5 years | 1.5× annual reward | 150 |
| 2 years | 2.0× annual reward | 200 |

The full formula uses integer arithmetic only:

```text
maximum_reward = principal × annual_reward_bps / 10,000 × lock_seconds / 31,536,000
vested_reward = maximum_reward × min(elapsed, lock_seconds) / lock_seconds
claimable = vested_reward − previously_claimed
```

Rewards vest continuously. A staker may claim vested rewards during the lock, but principal can be withdrawn only after maturity. The vault reserves the complete maximum reward when a stake is created; it rejects positions that the reward pool cannot cover.

## Features

- Exact `u128` token accounting; no floats or wall-clock reads
- Configurable annual rate and fixed lock bounds
- Reward-pool collateralization and reservation to prevent over-promising
- Owner-only claims and maturity-only principal withdrawal
- Monotonic, caller-supplied timestamps for deterministic contract tests
- Immutable position terms and audit-style event log
- Checked arithmetic and atomic error paths
- Thorough unit tests for the happy path and common attack/error cases

## Run it

```bash
cargo run
cargo test
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

## Example output

```text
Claimable halfway through a 1.5-year term: 75 tokens
Claimed: 75 tokens
Maturity payout (principal + remaining reward): 1,075 tokens
Alice's final balance: 10,150 tokens
```

## Production adaptation

This is the contract domain layer, not a deployment to a public chain. To deploy it, replace the in-memory ledger and event vector with a token standard, persistent storage, native caller identity, and the chain timestamp. Before handling real funds, commission a professional security audit and add runtime-specific integration tests, pause/governance controls, token-decimal handling, and an explicit upgrade policy.

## Resume-ready description

> Built a dependency-free Rust staking-vault domain engine with linearly vested fixed-term rewards, full reward collateralization, checked `u128` accounting, authorization boundaries, event logs, and comprehensive adversarial unit tests. Designed the logic to be portable to on-chain runtimes such as CosmWasm or Solana.
# Staking-Vault
