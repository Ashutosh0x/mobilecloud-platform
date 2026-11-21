//! Strict zero-shares-on-loan validation (Proof of Legal Entitlement, $E_t$).
//!
//! Securities lending is **strictly prohibited** for eligible backing. If a
//! custodian statement reports `shares_on_loan > 0`, every loaned share is
//! disqualified from eligible backing and the envelope fails verification
//! (10/10 blueprint §4, accounting boundary rule 3).

use crate::PoRError;

/// SEC Rule 15c3-3 segregation states recognized in evidence payloads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SegregationStatus {
    /// Omnibus segregated customer account — bankruptcy-remote.
    SecRule15c33Omnibus,
    /// Fully disclosed/segregated individual customer accounts.
    SecRule15c33FullyDisclosed,
    /// Proprietary (non-customer) position: **disqualifying** for entitlement.
    Proprietary,
    Unknown,
}

impl SegregationStatus {
    pub fn parse(value: &str) -> SegregationStatus {
        match value {
            "SEC_RULE_15C3_3_OMNIBUS" => SegregationStatus::SecRule15c33Omnibus,
            "SEC_RULE_15C3_3_FULLY_DISCLOSED" => SegregationStatus::SecRule15c33FullyDisclosed,
            "PROPRIETARY" => SegregationStatus::Proprietary,
            _ => SegregationStatus::Unknown,
        }
    }

    pub fn is_customer_segregated(&self) -> bool {
        matches!(
            self,
            SegregationStatus::SecRule15c33Omnibus | SegregationStatus::SecRule15c33FullyDisclosed
        )
    }
}

/// Proof of Legal Entitlement evidence set (Four Proofs, item 3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntitlementProof {
    pub segregation_status: SegregationStatus,
    /// Custody accounts must be bankruptcy-remote from the broker balance sheet.
    pub bankruptcy_remote: bool,
    /// Custody register reconciles with the SEC Transfer Agent master register.
    pub matches_transfer_agent_register: bool,
    /// Certified `shares_on_loan` figure from the custodian statement.
    pub shares_on_loan: u128,
}

impl EntitlementProof {
    /// Full entitlement validation. Any failure disqualifies the entire
    /// snapshot from attestation — partial entitlement is never publishable.
    pub fn validate(&self) -> Result<(), PoRError> {
        if self.shares_on_loan != 0 {
            return Err(PoRError::RehypothecationDetected);
        }
        if !self.segregation_status.is_customer_segregated() {
            return Err(PoRError::InvalidEvidence);
        }
        if !self.bankruptcy_remote {
            return Err(PoRError::InvalidEvidence);
        }
        if !self.matches_transfer_agent_register {
            return Err(PoRError::InvalidEvidence);
        }
        Ok(())
    }
}

/// Defensive disqualification: remove every loaned share from a raw custody
/// figure. For a compliant custodian this is a no-op (`loaned == 0`); for a
/// non-compliant one it strips the loaned quantity before any ratio math.
pub fn disqualify_loaned_shares(total_custody: u128, shares_on_loan: u128) -> Result<u128, PoRError> {
    total_custody
        .checked_sub(shares_on_loan)
        .ok_or(PoRError::ArithmeticUnderflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_on_loan_is_only_acceptable_state() {
        let proof = EntitlementProof {
            segregation_status: SegregationStatus::SecRule15c33Omnibus,
            bankruptcy_remote: true,
            matches_transfer_agent_register: true,
            shares_on_loan: 0,
        };
        assert!(proof.validate().is_ok());
    }

    #[test]
    fn any_loaned_share_fails() {
        let proof = EntitlementProof {
            shares_on_loan: 1,
            segregation_status: SegregationStatus::SecRule15c33Omnibus,
            bankruptcy_remote: true,
            matches_transfer_agent_register: true,
        };
        assert_eq!(proof.validate(), Err(PoRError::RehypothecationDetected));
    }

    #[test]
    fn proprietary_positions_disqualify() {
        let proof = EntitlementProof {
            segregation_status: SegregationStatus::Proprietary,
            bankruptcy_remote: true,
            matches_transfer_agent_register: true,
            shares_on_loan: 0,
        };
        assert_eq!(proof.validate(), Err(PoRError::InvalidEvidence));
    }

    #[test]
    fn disqualification_strips_loaned_shares() {
        assert_eq!(
            disqualify_loaned_shares(850_000, 0).unwrap(),
            850_000
        );
        assert_eq!(
            disqualify_loaned_shares(850_000, 1_000).unwrap(),
            849_000
        );
        assert_eq!(
            disqualify_loaned_shares(1_000, 2_000),
            Err(PoRError::ArithmeticUnderflow)
        );
    }
}
