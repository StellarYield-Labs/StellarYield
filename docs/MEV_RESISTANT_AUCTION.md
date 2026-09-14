# MEV-Resistant Solver Auction — Threat Model & Operator Runbook

## 1. System Overview

The Rebalance Auction Protocol converts approved vault rebalance plans into domain-separated on-chain intents, accepts competing solver bids via a commit/reveal mechanism, selects a valid winner, settles atomically, and records exact post-trade allocation deltas.

### Architecture Components

```
┌─────────────────────────────────────────────────────────────────┐
│                     Rebalance Auction Protocol                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │  Intent      │    │  Commit/     │    │  Settlement  │       │
│  │  Contract    │───▶│  Reveal      │───▶│  Contract    │       │
│  │  (Soroban)   │    │  Auction     │    │  (Soroban)   │       │
│  └──────────────┘    └──────────────┘    └──────────────┘       │
│         │                   │                    │                │
│         ▼                   ▼                    ▼                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Off-Chain Coordination Layer                 │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │   │
│  │  │   Auction   │  │   Solver    │  │   Keeper    │      │   │
│  │  │   Service   │  │   Worker    │  │   Workers   │      │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘      │   │
│  └──────────────────────────────────────────────────────────┘   │
│         │                   │                    │                │
│         ▼                   ▼                    ▼                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Prisma Database                         │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │   │
│  │  │   Intent    │  │   Solver    │  │   Audit     │      │   │
│  │  │   Records   │  │   Bids      │  │   Logs      │      │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘      │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Threat Model

### 2.1 Adversary Classes

| Adversary | Capability | Goal |
|-----------|-----------|------|
| **Malicious Solver** | Submit bids, observe public state | Extract MEV, manipulate prices |
| **Front-Runner** | Observe pending intents, submit transactions | Copy winning strategies, sandwich attacks |
| **Bond Slasher** | Submit invalid bids | Drain solver bonds |
| **Protocol Operator** | Admin access, pause/cancel | Censor intents, manipulate auctions |
| **Vault Compromiser** | Compromised vault key | Drain funds via malicious intents |
| **Network Adversary** | Observe network traffic | Extract bid data before reveal |

### 2.2 Attack Vectors & Mitigations

#### 2.2.1 MEV Extraction (Sandwich Attacks)

**Threat:** An adversary observes a pending rebalance intent and front-runs it to extract value.

**Mitigations:**
- **Intent-Based Architecture:** Users never submit raw swap transactions. All execution goes through the auction protocol.
- **Commit/Reveal Scheme:** Solvers commit hashed bids first, preventing bid copying.
- **Domain-Separated Hashing:** Each intent includes a unique domain separator (`StellarYield::RebalanceAuction::v1`) preventing cross-contract replay.
- **Atomic Settlement:** All-or-nothing execution prevents partial sandwich attacks.

**Residual Risk:** Low. The commit/reveal scheme ensures bid values are hidden until reveal phase.

#### 2.2.2 Bid Copying

**Threat:** A solver observes another solver's bid and copies the strategy.

**Mitigations:**
- **Commit Phase:** All bids are hashed before submission. Only the hash is visible.
- **Reveal Phase:** Bids are revealed after the commit phase ends, preventing copying.
- **Deterministic Ranking:** Winner selection is based on committed bid data, not reveal order.

**Residual Risk:** Low. The hash commitment prevents bid observation during the critical period.

#### 2.2.3 Front-Running

**Threat:** An adversary submits a transaction ahead of the solver's settlement.

**Mitigations:**
- **On-Chain Settlement:** Settlement is executed atomically on-chain.
- **Intent Expiry:** Intents have a finite lifetime (max 24 hours).
- **State Machine:** Clear state transitions prevent replay.

**Residual Risk:** Low. Atomic execution prevents front-running of settlement.

#### 2.2.4 Bond Slashing

**Threat:** A solver submits an invalid bid and loses their bond.

**Mitigations:**
- **Route Validation:** All routes are validated against allowlisted protocols and tokens.
- **Constraint Validation:** Bids must meet all intent constraints (slippage, fees, output).
- **Reputation System:** Solvers build reputation over time, discouraging invalid bids.

**Residual Risk:** Medium. Bond slashing is a necessary penalty mechanism.

#### 2.2.5 Protocol Operator Abuse

**Threat:** A compromised operator censors intents or manipulates auctions.

**Mitigations:**
- **Decentralized Solvers:** Multiple independent solvers compete.
- **On-Chain Verification:** All constraints are verified on-chain.
- **Audit Logging:** All actions are logged with timestamps and actor addresses.
- **Emergency Pause:** Operator can pause the system in case of compromise.

**Residual Risk:** Medium. Operator is a trusted party in the current design.

#### 2.2.6 Vault Key Compromise

**Threat:** An attacker compromises the vault key and creates malicious intents.

**Mitigations:**
- **Cancellation Authority:** Only the vault can cancel intents.
- **Intent Constraints:** Intents have strict loss, slippage, and fee limits.
- **Expiry:** Intents expire after 24 hours.

**Residual Risk:** High. Key compromise is a critical failure mode.

---

## 3. Security Invariants

The following invariants MUST hold at all times:

### 3.1 Single Consumption
**Invariant:** A valid intent can consume vault funds at most once.

**Verification:**
- `SettlementRecord(intent_id)` exists → intent state is `SETTLED`
- Intent state is `SETTLED` → no further settlements allowed
- Duplicate settlement attempts are rejected

### 3.2 Constraint Enforcement
**Invariant:** Settlement cannot exceed any per-asset, aggregate loss, fee, or slippage bound in the signed intent.

**Verification:**
- `realized_slippage_bps <= max_slippage_bps`
- `total_fees <= max_fees_bps`
- `price_impact <= max_price_impact_bps`
- `aggregate_loss <= max_total_loss_bps`

### 3.3 Deterministic Ranking
**Invariant:** Solver ranking is deterministic from committed bid data.

**Verification:**
- Ranking criteria: output value → slippage → price impact → reveal timestamp
- Same inputs always produce the same ranking
- No randomness in winner selection

### 3.4 Partial Fill Safety
**Invariant:** A failed route cannot leave only a subset of required transfers committed unless the intent explicitly allows that partial-fill state.

**Verification:**
- `PartialFillPolicy::FullOnly` → all-or-nothing execution
- `PartialFillPolicy::ProRata` → proportional execution allowed
- Residual intent has new nonce and unchanged aggregate risk limits

### 3.5 On-Chain Evidence
**Invariant:** Queue completion requires confirmed on-chain evidence, not only submission.

**Verification:**
- `Settlement.tx_hash` is a valid on-chain transaction hash
- `Settlement.settlement_ledger` is a confirmed ledger sequence
- Pre/post balances are recorded on-chain

### 3.6 Target Tolerance
**Invariant:** The vault's post-settlement balances satisfy the target tolerance or the recorded partial-fill constraints.

**Verification:**
- `fill_deltas` match expected allocation changes
- Post-settlement balances are within `target_min_bps` to `target_max_bps`

### 3.7 No Revival
**Invariant:** Expired or cancelled intents cannot be revived by retries.

**Verification:**
- Intent state is terminal (`SETTLED`, `CANCELLED`, `EXPIRED`, `FAILED`)
- Retry attempts on terminal intents are rejected
- State transitions are one-directional

---

## 4. Execution State Machine

```
                        ┌─────────────┐
                        │   Intent    │
                        │   Created   │
                        └──────┬──────┘
                               │
                               ▼
                        ┌─────────────┐
                ┌──────│   Auction   │──────┐
                │      │    Open     │      │
                │      └──────┬──────┘      │
                │             │             │
                │             ▼             │
                │      ┌─────────────┐      │
                │      │  Bidding    │      │
                │      │   Closed    │      │
                │      └──────┬──────┘      │
                │             │             │
                │             ▼             │
                │      ┌─────────────┐      │
                │      │   Winner    │      │
                │      │  Selected   │      │
                │      └──────┬──────┘      │
                │             │             │
                │             ▼             │
                │      ┌─────────────┐      │
                │      │ Settlement  │      │
                │      │  Pending    │      │
                │      └──────┬──────┘      │
                │             │             │
                │             ▼             │
                │      ┌─────────────┐      │
                │      │   Settled   │      │
                │      └─────────────┘      │
                │                           │
                │      ┌─────────────┐      │
                └─────▶│  Cancelled  │◀─────┘
                │      └─────────────┘      │
                │                           │
                │      ┌─────────────┐      │
                └─────▶│   Expired   │◀─────┘
                       └─────────────┘
                               │
                               ▼
                        ┌─────────────┐
                        │   Failed    │
                        └─────────────┘
```

### State Transitions

| From | To | Trigger | Validation |
|------|-----|---------|------------|
| IntentCreated | AuctionOpen | create_intent() | Vault auth, valid expiry |
| AuctionOpen | BiddingClosed | reveal_bid() | First reveal received |
| BiddingClosed | WinnerSelected | select_winner() | Admin auth, valid bids |
| WinnerSelected | SettlementPending | settle() | Solver auth, valid state |
| SettlementPending | Settled | settle() | On-chain confirmation |
| Any (non-terminal) | Cancelled | cancel_intent() | Authority auth |
| Any (non-terminal) | Expired | expire_intent() | Past expiry ledger |
| Any (non-terminal) | Failed | settle() | Constraint violation |

---

## 5. Operator Runbook

### 5.1 Normal Operations

#### Starting the System
```bash
# Start the queue processor in auction mode
npm run start:queue-processor -- --auction-mode

# Start solver workers
npm run start:solver-worker
```

#### Monitoring Auction Health
```bash
# Check active auctions
curl /api/auction/status?state=AUCTION_OPEN

# Check solver participation
curl /api/auction/solvers/active

# Check settlement success rate
curl /api/auction/metrics/settlement-rate
```

### 5.2 Emergency Procedures

#### Pause the System
```bash
# Emergency pause (stops all new intents and settlements)
curl -X POST /api/admin/pause

# Verify pause state
curl /api/admin/status
```

#### Cancel a Malicious Intent
```bash
# Cancel by intent ID (requires vault authority)
curl -X POST /api/admin/cancel-intent \
  -d '{"intentId": "intent-123", "reason": "Suspicious activity"}'
```

#### Force Expire Stale Intents
```bash
# Expire all intents past their expiry ledger
curl -X POST /api/admin/expire-stale
```

### 5.3 Troubleshooting

#### Intent Stuck in AUCTION_OPEN
**Symptoms:** Intent not progressing through auction phases.

**Diagnosis:**
1. Check `commitPhaseEnd` timestamp
2. Check solver participation count
3. Check network connectivity

**Resolution:**
- If past commit phase with no bids: `expire_intent()`
- If solver issues: Check solver worker logs

#### Settlement Failed
**Symptoms:** Intent in SETTLEMENT_PENDING but not settling.

**Diagnosis:**
1. Check on-chain transaction status
2. Verify solver balance
3. Check constraint violations

**Resolution:**
- If transaction failed: Mark as FAILED
- If constraint violation: Slash solver bond
- If network issue: Retry settlement

#### Solver Bond Slashed
**Symptoms:** Solver lost their bond.

**Diagnosis:**
1. Check `SolverBid.bondSlashed` flag
2. Review audit logs for constraint violations
3. Check solver reputation score

**Resolution:**
- Bond is permanently slashed
- Solver reputation decreased
- Consider adding to blocklist if repeated

### 5.4 Monitoring Queries

#### Active Auctions
```sql
SELECT id, vaultId, state, createdAt
FROM RebalanceAuctionIntent
WHERE state IN ('AUCTION_OPEN', 'BIDDING_CLOSED', 'WINNER_SELECTED')
ORDER BY createdAt DESC;
```

#### Solver Performance
```sql
SELECT 
  solverAddress,
  COUNT(*) as totalBids,
  SUM(CASE WHEN rank = 1 THEN 1 ELSE 0 END) as wins,
  AVG(totalOutputValue) as avgOutput
FROM SolverBid
WHERE revealed = true
GROUP BY solverAddress;
```

#### Settlement Success Rate
```sql
SELECT 
  DATE(settledAt) as date,
  COUNT(*) as settlements,
  AVG(realizedSlippageBps) as avgSlippage
FROM AuctionSettlement
GROUP BY DATE(settledAt)
ORDER BY date DESC;
```

### 5.5 Recovery Procedures

#### Crash Recovery
1. Check database for intents in non-terminal states
2. For each intent in `AUCTION_OPEN` or `BIDDING_CLOSED`:
   - Check if past expiry → `expire_intent()`
   - Otherwise, continue processing
3. For each intent in `WINNER_SELECTED`:
   - Verify on-chain state
   - If not settled: retry settlement
4. For each intent in `SETTLEMENT_PENDING`:
   - Check on-chain confirmation
   - If confirmed: mark as `SETTLED`
   - If failed: mark as `FAILED`

#### Database Recovery
1. Verify all foreign key constraints
2. Check for orphaned `SolverBid` records
3. Verify `ExecutionAuditLog` completeness
4. Run consistency checks on `SolverReputation`

---

## 6. Audit Checklist

### Pre-Deployment
- [ ] All security invariants verified
- [ ] Property tests passing
- [ ] Crash recovery tested
- [ ] Concurrent processor isolation verified
- [ ] Bond slashing mechanics tested
- [ ] Route validation comprehensive
- [ ] Intent expiry enforced
- [ ] Cancellation authority correct

### Post-Deployment
- [ ] Monitor settlement success rate
- [ ] Track solver reputation scores
- [ ] Audit log completeness
- [ ] Bond slashing frequency
- [ ] Intent expiry rates
- [ ] Solver participation rates

---

## 7. Known Limitations

1. **Operator Trust:** The current design requires a trusted operator for winner selection. Future versions should implement decentralized winner selection.

2. **Solver Centralization:** Currently only two reference solvers. Production should have 5+ independent solvers.

3. **Route Optimization:** Current solvers use simple routing. Production solvers should use actual DEX liquidity data.

4. **Cross-Chain:** This protocol only supports Stellar. Cross-chain rebalances are out of scope.

5. **Optimal Routing:** The protocol does not guarantee optimal routing across every Stellar protocol.

---

## 8. Future Improvements

1. **Decentralized Winner Selection:** Use on-chain VRF for unbiased winner selection.
2. **Solver Marketplace:** Permissionless solver registration with staking.
3. **Advanced Routing:** Integration with actual DEX aggregators.
4. **Cross-Chain:** Support for cross-chain rebalances via bridges.
5. **MEV Protection:** Integration with MEV protection services.
