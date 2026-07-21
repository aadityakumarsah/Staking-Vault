//! Deterministic business logic for a fixed-term staking vault.
//!
//! The vault deliberately has no chain SDK dependency. It is therefore easy to
//! test, audit, and adapt to a runtime such as CosmWasm, Solana, or an EVM
//! binding. Time is injected into each call instead of being read from the
//! system clock, which makes every transition deterministic.
//!
//! ## Reward model
//!
//! A position's maximum reward scales linearly with its selected term:
//!
//! ```text
//! maximum_reward = principal × annual_rate × lock_seconds / SECONDS_PER_YEAR
//! vested_reward = maximum_reward × elapsed_seconds / lock_seconds
//! ```
//!
//! With a 10% annual rate, a 1-year position earns 10%, a 1.5-year position
//! earns 15%, and a 2-year position earns 20% at maturity. Rewards vest
//! continuously and can be claimed during the lock; principal can only be
//! withdrawn at maturity.

use std::collections::BTreeMap;
use std::fmt;

/// A conventional 365-day year used for deterministic reward calculation.
pub const SECONDS_PER_YEAR: u64 = 31_536_000;
pub const BPS_DENOMINATOR: u16 = 10_000;
const VAULT_ACCOUNT: &str = "__linear_staking_vault__";

/// Smallest unit of the staked token. Do not use floating-point amounts.
pub type Amount = u128;
pub type PositionId = u64;

/// A validated account identifier for this chain-agnostic model.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct Address(String);

impl Address {
    pub fn new(value: impl Into<String>) -> Result<Self, Error> {
        let value = value.into();
        if value.trim().is_empty() || value == VAULT_ACCOUNT {
            return Err(Error::InvalidAddress);
        }
        Ok(Self(value))
    }

    fn vault() -> Self {
        Self(VAULT_ACCOUNT.to_owned())
    }
}

impl fmt::Display for Address {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Immutable parameters established when the vault is deployed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    /// Account allowed to seed the reward pool.
    pub admin: Address,
    /// Annual reward in basis points. `1_000` means 10.00% per year.
    pub annual_reward_bps: u16,
    /// Shortest permitted fixed term in seconds.
    pub min_lock_seconds: u64,
    /// Longest permitted fixed term in seconds.
    pub max_lock_seconds: u64,
}

impl Config {
    pub fn validate(&self) -> Result<(), Error> {
        if self.annual_reward_bps > BPS_DENOMINATOR {
            return Err(Error::InvalidRate);
        }
        if self.min_lock_seconds == 0 || self.min_lock_seconds > self.max_lock_seconds {
            return Err(Error::InvalidLockRange);
        }
        Ok(())
    }
}

/// An immutable stake plus the amount already paid from its reward entitlement.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Position {
    pub id: PositionId,
    pub owner: Address,
    pub principal: Amount,
    pub created_at: u64,
    pub lock_seconds: u64,
    pub total_reward: Amount,
    pub reward_paid: Amount,
}

impl Position {
    pub fn unlocks_at(&self) -> u64 {
        self.created_at.saturating_add(self.lock_seconds)
    }
}

/// Audit-friendly events emitted for every value-moving transition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Event {
    RewardsFunded {
        funder: Address,
        amount: Amount,
    },
    StakeCreated {
        position_id: PositionId,
        owner: Address,
        principal: Amount,
        lock_seconds: u64,
        maximum_reward: Amount,
    },
    RewardsClaimed {
        position_id: PositionId,
        owner: Address,
        amount: Amount,
    },
    PrincipalWithdrawn {
        position_id: PositionId,
        owner: Address,
        principal: Amount,
    },
}

/// Domain errors. All public mutations are atomic: an error leaves state unchanged.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    InvalidAddress,
    InvalidRate,
    InvalidLockRange,
    InvalidLockDuration,
    ZeroAmount,
    Unauthorized,
    InsufficientBalance,
    InsufficientUnreservedRewards,
    PositionNotFound,
    NotPositionOwner,
    PositionStillLocked { unlocks_at: u64 },
    InvalidTimestamp,
    NothingToClaim,
    ArithmeticOverflow,
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidAddress => {
                formatter.write_str("address must be non-empty and cannot be the vault")
            }
            Self::InvalidRate => {
                formatter.write_str("annual reward rate cannot exceed 10,000 basis points")
            }
            Self::InvalidLockRange => {
                formatter.write_str("lock range must be non-zero and ordered")
            }
            Self::InvalidLockDuration => {
                formatter.write_str("lock duration is outside the configured range")
            }
            Self::ZeroAmount => formatter.write_str("amount must be non-zero"),
            Self::Unauthorized => formatter.write_str("caller is not authorized for this action"),
            Self::InsufficientBalance => formatter.write_str("insufficient token balance"),
            Self::InsufficientUnreservedRewards => {
                formatter.write_str("reward pool cannot collateralize this position")
            }
            Self::PositionNotFound => formatter.write_str("position does not exist"),
            Self::NotPositionOwner => formatter.write_str("caller does not own this position"),
            Self::PositionStillLocked { unlocks_at } => {
                write!(formatter, "principal remains locked until {unlocks_at}")
            }
            Self::InvalidTimestamp => {
                formatter.write_str("timestamp precedes the position creation time")
            }
            Self::NothingToClaim => formatter.write_str("no newly vested rewards are available"),
            Self::ArithmeticOverflow => formatter.write_str("arithmetic overflow"),
        }
    }
}

impl std::error::Error for Error {}

/// A fully collateralized fixed-term staking vault.
///
/// `reward_balance` is token liquidity earmarked for rewards, while
/// `reserved_rewards` is the subset already promised to open positions. The
/// invariant `reserved_rewards <= reward_balance` is maintained on every call.
#[derive(Clone, Debug)]
pub struct StakingVault {
    config: Config,
    balances: BTreeMap<Address, Amount>,
    positions: BTreeMap<PositionId, Position>,
    events: Vec<Event>,
    next_position_id: PositionId,
    principal_liability: Amount,
    reward_balance: Amount,
    reserved_rewards: Amount,
}

impl StakingVault {
    /// Creates a vault and its in-memory token ledger. Initial balances make
    /// the example self-contained; a chain adapter would replace transfers
    /// with the chain's token calls.
    pub fn new(
        config: Config,
        initial_balances: impl IntoIterator<Item = (Address, Amount)>,
    ) -> Result<Self, Error> {
        config.validate()?;

        let mut balances = BTreeMap::new();
        for (address, amount) in initial_balances {
            if address == Address::vault() {
                return Err(Error::InvalidAddress);
            }
            let entry = balances.entry(address).or_default();
            *entry = entry.checked_add(amount).ok_or(Error::ArithmeticOverflow)?;
        }

        Ok(Self {
            config,
            balances,
            positions: BTreeMap::new(),
            events: Vec::new(),
            next_position_id: 1,
            principal_liability: 0,
            reward_balance: 0,
            reserved_rewards: 0,
        })
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    pub fn balance_of(&self, address: &Address) -> Amount {
        self.balance(address)
    }

    pub fn vault_balance(&self) -> Amount {
        self.balance(&Address::vault())
    }

    pub fn position(&self, position_id: PositionId) -> Option<&Position> {
        self.positions.get(&position_id)
    }

    pub fn positions_for(&self, owner: &Address) -> Vec<&Position> {
        self.positions
            .values()
            .filter(|position| &position.owner == owner)
            .collect()
    }

    pub fn events(&self) -> &[Event] {
        &self.events
    }

    pub fn principal_liability(&self) -> Amount {
        self.principal_liability
    }

    pub fn reward_balance(&self) -> Amount {
        self.reward_balance
    }

    pub fn reserved_rewards(&self) -> Amount {
        self.reserved_rewards
    }

    pub fn available_rewards(&self) -> Amount {
        self.reward_balance - self.reserved_rewards
    }

    /// Moves the admin's tokens into the vault's reward pool.
    pub fn fund_rewards(&mut self, caller: &Address, amount: Amount) -> Result<(), Error> {
        if caller != &self.config.admin {
            return Err(Error::Unauthorized);
        }
        require_nonzero(amount)?;
        self.ensure_transfer(caller, &Address::vault(), amount)?;
        let new_reward_balance = self
            .reward_balance
            .checked_add(amount)
            .ok_or(Error::ArithmeticOverflow)?;

        self.transfer(caller, &Address::vault(), amount)?;
        self.reward_balance = new_reward_balance;
        self.events.push(Event::RewardsFunded {
            funder: caller.clone(),
            amount,
        });
        self.assert_invariants();
        Ok(())
    }

    /// Opens a collateralized position. The maximum reward is reserved before
    /// the principal is accepted, so successful stakes can always be paid.
    pub fn stake(
        &mut self,
        caller: &Address,
        principal: Amount,
        lock_seconds: u64,
        now: u64,
    ) -> Result<PositionId, Error> {
        require_nonzero(principal)?;
        if lock_seconds < self.config.min_lock_seconds
            || lock_seconds > self.config.max_lock_seconds
        {
            return Err(Error::InvalidLockDuration);
        }
        self.ensure_transfer(caller, &Address::vault(), principal)?;

        let total_reward = reward_for_term(principal, self.config.annual_reward_bps, lock_seconds)?;
        let new_reserved_rewards = self
            .reserved_rewards
            .checked_add(total_reward)
            .ok_or(Error::ArithmeticOverflow)?;
        if new_reserved_rewards > self.reward_balance {
            return Err(Error::InsufficientUnreservedRewards);
        }
        let new_principal_liability = self
            .principal_liability
            .checked_add(principal)
            .ok_or(Error::ArithmeticOverflow)?;
        let position_id = self.next_position_id;
        let next_position_id = position_id
            .checked_add(1)
            .ok_or(Error::ArithmeticOverflow)?;

        self.transfer(caller, &Address::vault(), principal)?;
        self.positions.insert(
            position_id,
            Position {
                id: position_id,
                owner: caller.clone(),
                principal,
                created_at: now,
                lock_seconds,
                total_reward,
                reward_paid: 0,
            },
        );
        self.next_position_id = next_position_id;
        self.principal_liability = new_principal_liability;
        self.reserved_rewards = new_reserved_rewards;
        self.events.push(Event::StakeCreated {
            position_id,
            owner: caller.clone(),
            principal,
            lock_seconds,
            maximum_reward: total_reward,
        });
        self.assert_invariants();
        Ok(position_id)
    }

    /// Returns newly vested, unclaimed rewards at `now` without changing state.
    pub fn claimable_rewards(&self, position_id: PositionId, now: u64) -> Result<Amount, Error> {
        let position = self
            .positions
            .get(&position_id)
            .ok_or(Error::PositionNotFound)?;
        claimable_at(position, now)
    }

    /// Pays the currently vested portion of a position's reserved reward.
    pub fn claim_rewards(
        &mut self,
        caller: &Address,
        position_id: PositionId,
        now: u64,
    ) -> Result<Amount, Error> {
        let position = self
            .positions
            .get(&position_id)
            .ok_or(Error::PositionNotFound)?;
        if &position.owner != caller {
            return Err(Error::NotPositionOwner);
        }
        let amount = claimable_at(position, now)?;
        require_nonzero_claim(amount)?;
        self.ensure_transfer(&Address::vault(), caller, amount)?;

        let position = self
            .positions
            .get_mut(&position_id)
            .expect("position checked above");
        position.reward_paid = position
            .reward_paid
            .checked_add(amount)
            .ok_or(Error::ArithmeticOverflow)?;
        self.reserved_rewards = self
            .reserved_rewards
            .checked_sub(amount)
            .expect("claimed rewards are reserved");
        self.reward_balance = self
            .reward_balance
            .checked_sub(amount)
            .expect("claimed rewards are funded");
        self.transfer(&Address::vault(), caller, amount)?;
        self.events.push(Event::RewardsClaimed {
            position_id,
            owner: caller.clone(),
            amount,
        });
        self.assert_invariants();
        Ok(amount)
    }

    /// Returns principal after the selected term. Any remaining vested reward
    /// is paid atomically with the principal, then the position is closed.
    pub fn withdraw(
        &mut self,
        caller: &Address,
        position_id: PositionId,
        now: u64,
    ) -> Result<Amount, Error> {
        let position = self
            .positions
            .get(&position_id)
            .ok_or(Error::PositionNotFound)?
            .clone();
        if &position.owner != caller {
            return Err(Error::NotPositionOwner);
        }
        if now < position.created_at {
            return Err(Error::InvalidTimestamp);
        }
        if now < position.unlocks_at() {
            return Err(Error::PositionStillLocked {
                unlocks_at: position.unlocks_at(),
            });
        }

        let remaining_reward = claimable_at(&position, now)?;
        let payout = position
            .principal
            .checked_add(remaining_reward)
            .ok_or(Error::ArithmeticOverflow)?;
        self.ensure_transfer(&Address::vault(), caller, payout)?;

        self.positions
            .remove(&position_id)
            .expect("position checked above");
        self.principal_liability = self
            .principal_liability
            .checked_sub(position.principal)
            .expect("principal liability covers open position");
        let outstanding_reward = position
            .total_reward
            .checked_sub(position.reward_paid)
            .expect("reward paid never exceeds entitlement");
        self.reserved_rewards = self
            .reserved_rewards
            .checked_sub(outstanding_reward)
            .expect("open position reward is reserved");
        self.reward_balance = self
            .reward_balance
            .checked_sub(remaining_reward)
            .expect("remaining reward is funded");
        self.transfer(&Address::vault(), caller, payout)?;

        if remaining_reward > 0 {
            self.events.push(Event::RewardsClaimed {
                position_id,
                owner: caller.clone(),
                amount: remaining_reward,
            });
        }
        self.events.push(Event::PrincipalWithdrawn {
            position_id,
            owner: caller.clone(),
            principal: position.principal,
        });
        self.assert_invariants();
        Ok(payout)
    }

    fn balance(&self, address: &Address) -> Amount {
        self.balances.get(address).copied().unwrap_or_default()
    }

    fn ensure_balance(&self, address: &Address, amount: Amount) -> Result<(), Error> {
        if self.balance(address) < amount {
            return Err(Error::InsufficientBalance);
        }
        Ok(())
    }

    fn ensure_transfer(&self, from: &Address, to: &Address, amount: Amount) -> Result<(), Error> {
        self.ensure_balance(from, amount)?;
        self.balance(to)
            .checked_add(amount)
            .ok_or(Error::ArithmeticOverflow)?;
        Ok(())
    }

    fn transfer(&mut self, from: &Address, to: &Address, amount: Amount) -> Result<(), Error> {
        self.ensure_transfer(from, to, amount)?;
        let to_balance = self
            .balance(to)
            .checked_add(amount)
            .ok_or(Error::ArithmeticOverflow)?;
        let from_balance = self.balance(from) - amount;
        self.balances.insert(from.clone(), from_balance);
        self.balances.insert(to.clone(), to_balance);
        Ok(())
    }

    fn assert_invariants(&self) {
        debug_assert!(self.reserved_rewards <= self.reward_balance);
        debug_assert_eq!(
            self.vault_balance(),
            self.principal_liability + self.reward_balance,
            "vault token balance must cover principal and reward liabilities"
        );
        debug_assert_eq!(
            self.positions.values().map(|p| p.principal).sum::<Amount>(),
            self.principal_liability
        );
        debug_assert_eq!(
            self.positions
                .values()
                .map(|p| p.total_reward - p.reward_paid)
                .sum::<Amount>(),
            self.reserved_rewards
        );
    }
}

fn require_nonzero(amount: Amount) -> Result<(), Error> {
    if amount == 0 {
        return Err(Error::ZeroAmount);
    }
    Ok(())
}

fn require_nonzero_claim(amount: Amount) -> Result<(), Error> {
    if amount == 0 {
        return Err(Error::NothingToClaim);
    }
    Ok(())
}

fn reward_for_term(
    principal: Amount,
    annual_reward_bps: u16,
    lock_seconds: u64,
) -> Result<Amount, Error> {
    let annual_reward = mul_div_floor(
        principal,
        Amount::from(annual_reward_bps),
        Amount::from(BPS_DENOMINATOR),
    )?;
    mul_div_floor(
        annual_reward,
        Amount::from(lock_seconds),
        Amount::from(SECONDS_PER_YEAR),
    )
}

fn claimable_at(position: &Position, now: u64) -> Result<Amount, Error> {
    if now < position.created_at {
        return Err(Error::InvalidTimestamp);
    }
    let elapsed = now
        .saturating_sub(position.created_at)
        .min(position.lock_seconds);
    let vested = mul_div_floor(
        position.total_reward,
        Amount::from(elapsed),
        Amount::from(position.lock_seconds),
    )?;
    vested
        .checked_sub(position.reward_paid)
        .ok_or(Error::ArithmeticOverflow)
}

/// Computes `floor(a × b / denominator)` without floating point. The quotient
/// decomposition avoids a large intermediate in the common staking formulas.
fn mul_div_floor(a: Amount, b: Amount, denominator: Amount) -> Result<Amount, Error> {
    debug_assert!(denominator > 0);
    let quotient_part = (a / denominator)
        .checked_mul(b)
        .ok_or(Error::ArithmeticOverflow)?;
    let remainder_part = (a % denominator)
        .checked_mul(b)
        .ok_or(Error::ArithmeticOverflow)?
        / denominator;
    quotient_part
        .checked_add(remainder_part)
        .ok_or(Error::ArithmeticOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = 86_400;
    const YEAR: u64 = SECONDS_PER_YEAR;

    fn address(value: &str) -> Address {
        Address::new(value).unwrap()
    }

    fn vault() -> StakingVault {
        StakingVault::new(
            Config {
                admin: address("admin"),
                annual_reward_bps: 1_000,
                min_lock_seconds: DAY,
                max_lock_seconds: YEAR * 3,
            },
            [
                (address("admin"), 1_000_000),
                (address("alice"), 10_000),
                (address("bob"), 10_000),
            ],
        )
        .unwrap()
    }

    #[test]
    fn reward_is_linear_across_one_one_point_five_and_two_year_terms() {
        let mut state = vault();
        state.fund_rewards(&address("admin"), 100_000).unwrap();

        let one_year = state.stake(&address("alice"), 1_000, YEAR, 0).unwrap();
        let one_and_half_year = state
            .stake(&address("alice"), 1_000, YEAR * 3 / 2, 0)
            .unwrap();
        let two_year = state.stake(&address("alice"), 1_000, YEAR * 2, 0).unwrap();

        assert_eq!(state.position(one_year).unwrap().total_reward, 100);
        assert_eq!(state.position(one_and_half_year).unwrap().total_reward, 150);
        assert_eq!(state.position(two_year).unwrap().total_reward, 200);
    }

    #[test]
    fn rewards_vest_linearly_and_can_be_claimed_in_parts() {
        let mut state = vault();
        state.fund_rewards(&address("admin"), 1_000).unwrap();
        let id = state.stake(&address("alice"), 1_000, YEAR, 100).unwrap();

        assert_eq!(state.claimable_rewards(id, 100 + YEAR / 2).unwrap(), 50);
        assert_eq!(
            state
                .claim_rewards(&address("alice"), id, 100 + YEAR / 2)
                .unwrap(),
            50
        );
        assert_eq!(state.claimable_rewards(id, 100 + YEAR * 3 / 4).unwrap(), 25);
        assert_eq!(
            state
                .claim_rewards(&address("alice"), id, 100 + YEAR)
                .unwrap(),
            50
        );
        assert_eq!(state.claimable_rewards(id, 100 + YEAR).unwrap(), 0);
    }

    #[test]
    fn withdrawals_are_locked_until_maturity() {
        let mut state = vault();
        state.fund_rewards(&address("admin"), 1_000).unwrap();
        let id = state.stake(&address("alice"), 1_000, YEAR, 0).unwrap();

        assert_eq!(
            state.withdraw(&address("alice"), id, YEAR - 1),
            Err(Error::PositionStillLocked { unlocks_at: YEAR })
        );
        assert_eq!(state.withdraw(&address("alice"), id, YEAR).unwrap(), 1_100);
        assert!(state.position(id).is_none());
    }

    #[test]
    fn maturity_withdrawal_pays_only_remaining_reward() {
        let mut state = vault();
        state.fund_rewards(&address("admin"), 1_000).unwrap();
        let id = state.stake(&address("alice"), 1_000, YEAR, 0).unwrap();
        state
            .claim_rewards(&address("alice"), id, YEAR / 2)
            .unwrap();

        assert_eq!(state.withdraw(&address("alice"), id, YEAR).unwrap(), 1_050);
        assert_eq!(state.balance_of(&address("alice")), 10_100);
    }

    #[test]
    fn cannot_open_an_uncollateralized_position() {
        let mut state = vault();
        state.fund_rewards(&address("admin"), 99).unwrap();

        assert_eq!(
            state.stake(&address("alice"), 1_000, YEAR, 0),
            Err(Error::InsufficientUnreservedRewards)
        );
        assert_eq!(state.balance_of(&address("alice")), 10_000);
        assert_eq!(state.principal_liability(), 0);
    }

    #[test]
    fn reservation_prevents_double_spending_the_reward_pool() {
        let mut state = vault();
        state.fund_rewards(&address("admin"), 150).unwrap();
        state.stake(&address("alice"), 1_000, YEAR, 0).unwrap();

        assert_eq!(
            state.stake(&address("bob"), 1_000, YEAR, 0),
            Err(Error::InsufficientUnreservedRewards)
        );
        assert_eq!(state.available_rewards(), 50);
    }

    #[test]
    fn only_admin_can_fund_rewards() {
        let mut state = vault();
        assert_eq!(
            state.fund_rewards(&address("alice"), 10),
            Err(Error::Unauthorized)
        );
    }

    #[test]
    fn only_owner_can_claim_or_withdraw() {
        let mut state = vault();
        state.fund_rewards(&address("admin"), 1_000).unwrap();
        let id = state.stake(&address("alice"), 1_000, YEAR, 0).unwrap();

        assert_eq!(
            state.claim_rewards(&address("bob"), id, YEAR),
            Err(Error::NotPositionOwner)
        );
        assert_eq!(
            state.withdraw(&address("bob"), id, YEAR),
            Err(Error::NotPositionOwner)
        );
    }

    #[test]
    fn rejects_invalid_lock_terms_and_zero_values() {
        let mut state = vault();
        state.fund_rewards(&address("admin"), 1_000).unwrap();

        assert_eq!(
            state.stake(&address("alice"), 0, YEAR, 0),
            Err(Error::ZeroAmount)
        );
        assert_eq!(
            state.stake(&address("alice"), 100, DAY - 1, 0),
            Err(Error::InvalidLockDuration)
        );
        assert_eq!(
            state.stake(&address("alice"), 100, YEAR * 3 + 1, 0),
            Err(Error::InvalidLockDuration)
        );
    }

    #[test]
    fn timestamps_before_creation_are_rejected() {
        let mut state = vault();
        state.fund_rewards(&address("admin"), 1_000).unwrap();
        let id = state.stake(&address("alice"), 1_000, YEAR, 100).unwrap();

        assert_eq!(
            state.claimable_rewards(id, 99),
            Err(Error::InvalidTimestamp)
        );
        assert_eq!(
            state.withdraw(&address("alice"), id, 99),
            Err(Error::InvalidTimestamp)
        );
    }

    #[test]
    fn configuration_is_validated() {
        let invalid_rate = Config {
            admin: address("admin"),
            annual_reward_bps: BPS_DENOMINATOR + 1,
            min_lock_seconds: DAY,
            max_lock_seconds: YEAR,
        };
        assert!(matches!(
            StakingVault::new(invalid_rate, []),
            Err(Error::InvalidRate)
        ));

        let invalid_range = Config {
            admin: address("admin"),
            annual_reward_bps: 0,
            min_lock_seconds: 0,
            max_lock_seconds: YEAR,
        };
        assert!(matches!(
            StakingVault::new(invalid_range, []),
            Err(Error::InvalidLockRange)
        ));
    }

    #[test]
    fn events_capture_value_moving_operations() {
        let mut state = vault();
        state.fund_rewards(&address("admin"), 1_000).unwrap();
        let id = state.stake(&address("alice"), 1_000, YEAR, 0).unwrap();
        state
            .claim_rewards(&address("alice"), id, YEAR / 2)
            .unwrap();
        state.withdraw(&address("alice"), id, YEAR).unwrap();

        assert_eq!(state.events().len(), 5);
        assert!(matches!(
            state.events()[0],
            Event::RewardsFunded { amount: 1_000, .. }
        ));
        assert!(matches!(
            state.events()[4],
            Event::PrincipalWithdrawn {
                principal: 1_000,
                ..
            }
        ));
    }
}
