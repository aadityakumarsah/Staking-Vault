use linear_staking_vault::{Address, Config, StakingVault, SECONDS_PER_YEAR};

fn address(value: &str) -> Address {
    Address::new(value).expect("demo addresses are valid")
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let admin = address("admin");
    let alice = address("alice");
    let mut vault = StakingVault::new(
        Config {
            admin: admin.clone(),
            annual_reward_bps: 1_000, // 10% each year
            min_lock_seconds: 86_400,
            max_lock_seconds: SECONDS_PER_YEAR * 3,
        },
        [(admin.clone(), 100_000), (alice.clone(), 10_000)],
    )?;

    vault.fund_rewards(&admin, 10_000)?;
    let position_id = vault.stake(&alice, 1_000, SECONDS_PER_YEAR * 3 / 2, 0)?;

    let half_term = SECONDS_PER_YEAR * 3 / 4;
    println!(
        "Claimable halfway through a 1.5-year term: {} tokens",
        vault.claimable_rewards(position_id, half_term)?
    );
    println!(
        "Claimed: {} tokens",
        vault.claim_rewards(&alice, position_id, half_term)?
    );
    println!(
        "Maturity payout (principal + remaining reward): {} tokens",
        vault.withdraw(&alice, position_id, SECONDS_PER_YEAR * 3 / 2)?
    );
    println!("Alice's final balance: {} tokens", vault.balance_of(&alice));

    Ok(())
}
