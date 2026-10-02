# Solana LST Redemption Lab

A research, observation, and technical-validation toolkit for atomic Solana liquid-staking-token (LST) redemptions funded by Kamino WSOL flash liquidity.

```text
Kamino flash-borrow WSOL
  → Jupiter exact-in swap: WSOL → whitelisted LST
  → SPL Stake Pool: UpdateStakePoolBalance
  → SPL Stake Pool: WithdrawSol (burn LST → native SOL)
  → wrap the exact Kamino repayment as WSOL
  → Kamino flash-repay
```

The project also contains a separate, intentionally non-executable DEX pair observer for protected `WSOL → stablecoin → WSOL` quote cycles.

> **WARNING — NOT FINANCIAL, INVESTMENT, TRADING, TAX, LEGAL, OR SECURITY ADVICE.**
>
> This is experimental DeFi software for mainnet research. It can lose money, fail to land, pay network fees on failed broadcasts, or behave differently as on-chain programs, liquidity, and RPC providers change. There is no guarantee of profit or safety.
>
> **Do your own research (DYOR).** Independently verify every program, mint, stake-pool account, token program, DEX label, quote, transaction, wallet address, and economic assumption before using any command. Use a dedicated, low-balance hot wallet. Never share a seed phrase or keypair JSON file.

---

## Table of contents

- [What this repository does](#what-this-repository-does)
- [What it does not do](#what-it-does-not-do)
- [How LST redemption works](#how-lst-redemption-works)
- [Candidate statuses and execution boundaries](#candidate-statuses-and-execution-boundaries)
- [Economic gate](#economic-gate)
- [Safety model and important risks](#safety-model-and-important-risks)
- [Requirements and installation](#requirements-and-installation)
- [Configuration](#configuration)
- [LST strategy whitelist](#lst-strategy-whitelist)
- [DEX pair observer](#dex-pair-observer)
- [Commands and operating procedure](#commands-and-operating-procedure)
- [Technical simulation](#technical-simulation)
- [Execution audit and balance reconciliation](#execution-audit-and-balance-reconciliation)
- [Output interpretation](#output-interpretation)
- [Repository map](#repository-map)
- [Testing](#testing)
- [Limitations](#limitations)
- [References](#references)
- [Donations](#donations)

---

## What this repository does

### 1. LST redemption scanner

The LST scanner reads an explicit public whitelist from `strategies.json`. For every enabled strategy and configured borrow amount, it:

1. Loads the configured Kamino market and WSOL reserve.
2. Reads available WSOL liquidity, the current flash-loan fee, and the hot-wallet SOL balance.
3. Loads the candidate stake-pool account and verifies that it is owned by the canonical SPL Stake Pool program.
4. Verifies the configured LST mint matches the stake-pool mint.
5. Verifies the stake-pool validator data is current for the epoch.
6. Verifies `WithdrawSol` is permissionless for the configured wallet.
7. Reads the stake-pool reserve and rejects an amount that cannot be paid from it.
8. Requests a Jupiter exact-in quote for `WSOL → configured LST`.
9. Uses Jupiter's protected `otherAmountThreshold`, not the optimistic quote output.
10. Estimates `WithdrawSol` proceeds from current pool exchange-rate and withdrawal-fee state.
11. Calculates the actual Kamino flash fee and the dynamic economic threshold.
12. Classifies the amount as rejected, technical-only, eligible, or scan-only.

The scanner itself does **not** send a transaction.

### 2. LST planning, simulation, and gated execution

For an eligible `mode: "execution"` strategy, the project can build an atomic Versioned Transaction containing:

```text
compute budget instructions
→ idempotent WSOL ATA creation
→ idempotent LST ATA creation
→ Kamino flash borrow
→ Jupiter setup instructions
→ Jupiter swap instructions
→ UpdateStakePoolBalance
→ WithdrawSol
→ native SOL transfer for exact flash repayment
→ SyncNative
→ Kamino flash repay
```

The standard `simulate` command runs an exact signed RPC simulation without broadcasting. The guarded `execute` command runs that simulation, broadcasts only after two explicit execution gates are present, waits for finality, and writes an audit receipt.

### 3. DEX pair observer

The pair observer is independent of LST redemption. It monitors only explicitly allowlisted, direct, two-venue cycles:

```text
WSOL → allowlisted intermediate token on venue A
protected output of leg 1 → WSOL on disjoint venue B
```

It is useful for observing protected quote economics. It has local `plan:pairs` and `simulate:pairs` commands when a fresh pair observation passes its gate, but it intentionally has **no pair send/execution command**.

---

## What it does not do

This repository is deliberately restrictive. It does **not**:

- search arbitrary tokens, pools, routes, or DEX labels;
- use unrestricted multi-hop Jupiter routes for the LST strategy;
- execute DEX pair cycles;
- broadcast from observation, planning, or simulation commands; only the explicitly armed LST `execute` and `watch --execute` paths can broadcast;
- let a `scan-only` LST strategy enter planning, simulation, or execution;
- lower profit, transaction-cost, flash-fee, or slippage protections merely to manufacture a candidate;
- guarantee that a profitable quote will land or remain profitable;
- replace an independent audit of the relevant Solana programs and accounts.

---

## How LST redemption works

An LST represents a claim on a stake pool. If the market price of the LST acquired through Jupiter is sufficiently favorable relative to the pool's protected immediate SOL redemption value, an atomic cycle can theoretically repay the WSOL flash loan and leave residual SOL.

The scanner deliberately models the conservative path:

```text
borrowRaw WSOL
  → Jupiter protected minimum LST output
  → burn exactly that protected minimum in WithdrawSol
  → conservative pool exchange-rate and withdrawal-fee estimate
  → expected native SOL withdrawal
  → repay principal + actual Kamino flash fee + configured cost budget + profit threshold
```

### Why the protected Jupiter threshold is used

Jupiter supplies both an optimistic `outAmount` and a slippage-protected `otherAmountThreshold`. The LST scanner burns the latter. Any favorable difference between the actual swap result and that threshold remains as LST in the wallet ATA rather than being counted as assumed profit.

This design makes the economic estimate more conservative and helps ensure the amount used by `WithdrawSol` can be satisfied even if the Jupiter swap lands at its protected minimum.

### Why `UpdateStakePoolBalance` is included

SPL stake pools may require a current balance update before a withdrawal. The transaction includes `UpdateStakePoolBalance` immediately before `WithdrawSol`, while the scanner separately rejects stale pool epoch data. This does not eliminate race or state-change risk; it is a safety measure, not a guarantee.

---

## Candidate statuses and execution boundaries

The LST scan table can show the following statuses.

| Status           | Meaning                                                                                                                                                   |                         May build |                      May simulate |                            May send |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------: | --------------------------------: | ----------------------------------: |
| `rejected`       | A validation, quote, reserve, raw-repayment, fee, or economic prerequisite failed.                                                                        |                                No |                                No |                                  No |
| `TECHNICAL ONLY` | An execution-mode candidate passed structural checks and protected proceeds cover raw flash repayment, but it does not satisfy the full cost/profit gate. | Only through `simulate:technical` | Only through `simulate:technical` |                                  No |
| `ELIGIBLE`       | An execution-mode candidate passed all scanner and economic gates.                                                                                        |                               Yes |                               Yes | Only after explicit execution gates |
| `SCAN ONLY`      | A research strategy is being observed. It is never selectable for a transaction path.                                                                     |                                No |                                No |                                  No |

### Strategy modes

Each LST strategy has one of two modes:

- `"execution"` — may be considered by normal planning, simulation, and execution, but only after all other gates pass.
- `"scan-only"` — participates in normal on-chain inspection and quote observation, but is barred from `plan`, `simulate`, `simulate:technical`, `execute`, and `watch --execute`.

Entries without a `mode` field are interpreted as `"execution"` for backward compatibility.

The execution boundary is enforced twice:

1. candidate selection functions choose execution-mode strategies only; and
2. the LST transaction builder rejects scan-only strategies directly.

A technical-simulation plan also carries its economic-gate state; `sendPlan` rejects a plan that did not clear the economic gate.

---

## Economic gate

All SOL and token amounts are handled as integer `bigint` values. No economics use JavaScript floating-point arithmetic.

For each candidate, the required protected final output is:

```text
minimum protected WithdrawSol output =
  flash principal
  + actual Kamino flash fee
  + MAX_TX_COST_SOL
  + MIN_NET_PROFIT_SOL
```

Definitions:

| Value                         | Meaning                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- |
| `flash principal`             | The requested WSOL flash-borrow amount.                                    |
| `actual Kamino flash fee`     | Read from the selected reserve and rounded up conservatively.              |
| `MAX_TX_COST_SOL`             | A configured network/rent/priority-fee risk budget.                        |
| `MIN_NET_PROFIT_SOL`          | The minimum expected profit after the configured cost budget.              |
| `expected net before network` | Protected expected withdrawal minus flash repayment.                       |
| `expected net after budget`   | Protected expected withdrawal minus flash repayment and `MAX_TX_COST_SOL`. |

An `ELIGIBLE` candidate must cover the whole formula. A `TECHNICAL ONLY` candidate is allowed only when it covers raw flash repayment but not the cost/profit margin, and it remains no-send.

### Example of a healthy versus unhealthy result

```text
Healthy base condition:
protected expected WithdrawSol >= flash principal + flash fee

Execution economic condition:
protected expected WithdrawSol >= flash principal + flash fee
                                  + MAX_TX_COST_SOL
                                  + MIN_NET_PROFIT_SOL
```

If protected withdrawal proceeds are below raw repayment, the transaction could rely on pre-existing wallet SOL to complete the exact repayment transfer. The scanner rejects that amount before technical simulation. Do not bypass this condition.

---

## Safety model and important risks

The following controls reduce risk; they do not remove it.

### On-chain and quote validation

- The configured Kamino reserve must be a WSOL reserve in the configured market.
- Available reserve liquidity is re-read for every scan.
- The stake-pool account must be owned by the canonical SPL Stake Pool program.
- The configured LST mint must equal the pool's on-chain mint.
- The pool's epoch state must be fresh.
- `WithdrawSol` must be permissionless for the hot wallet.
- The reserve must cover the estimated protected immediate redemption.
- Jupiter quote input/output mints and exact input amount are verified.
- The flash fee must remain within `MAX_FLASH_FEE_BPS`.
- Jupiter instruction validation can reject unexpected signers and sensitive program IDs through `STRICT_JUPITER_VALIDATION=true`.

### Wallet and atomicity risks

- A Solana transaction is atomic: if an instruction fails, its state changes revert. **The network fee can still be charged after a broadcast.**
- Atomicity does not mean no economic risk. State, liquidity, the stake-pool exchange rate, and a Jupiter route can change between quote, simulation, and landing.
- The current redemption flow receives redeemed SOL in the operator wallet, then transfers the exact repayment into the WSOL ATA. Keep the hot wallet balance small and dedicated. If the transaction design or state assumptions are wrong, pre-existing wallet SOL can be exposed to the repayment transfer.
- `simulate` is a point-in-time RPC execution preview, not a reservation of liquidity, block space, or price.
- A transaction that simulates successfully can still expire, be dropped, be front-run, fail on changed state, or become unprofitable before landing.
- A `finalized` receipt with `meta.err: null` proves that transaction execution succeeded. It does not independently value leftover LST, prove a strategy is repeatable, or make future transactions safe.

### Operational rules

1. Use a dedicated hot wallet, never a treasury or personal wallet.
2. Fund it only with the amount you are willing to expose to fees, ATA rent, and the strategy's failure modes.
3. Keep `EXECUTION_ENABLED=false` until you have reviewed all output and transactions yourself.
4. Never lower `MIN_NET_PROFIT_SOL`, `MAX_TX_COST_SOL`, `MAX_FLASH_FEE_BPS`, or slippage simply to force a pass.
5. Do not remove strict Jupiter validation unless you fully understand every instruction and signer being accepted.
6. Treat public RPC results as untrusted infrastructure input. Use a reliable mainnet RPC provider for serious research.
7. Verify every destination address before using the wallet transfer command.

---

## Requirements and installation

### Requirements

- Node.js **20.18 or newer**
- npm
- A Solana **mainnet-beta** RPC endpoint
- A local Solana-format keypair file for commands that sign or simulate LST transactions
- A dedicated hot wallet with enough SOL to satisfy the configured `MIN_GAS_BALANCE_SOL` check

The project is pinned to `mainnet-beta` because its default market, reserve, and strategy addresses are mainnet-specific.

### Install

```bash
git clone <YOUR_FORK_OR_REPOSITORY_URL> solana-lst-redemption-lab
cd solana-lst-redemption-lab
npm install
cp .env.example .env
```

Windows PowerShell:

```powershell
git clone <YOUR_FORK_OR_REPOSITORY_URL> solana-lst-redemption-lab
Set-Location solana-lst-redemption-lab
npm install
Copy-Item .env.example .env
```

Run local checks:

```bash
npm run typecheck
npm test
npm run format:check
```

---

## Configuration

Copy `.env.example` to `.env`. The `.env` file is ignored by Git; do not commit it.

### Minimal LST configuration

```env
RPC_URL=https://your-mainnet-rpc.example.com
KEYPAIR_PATH=~/.config/solana/flash-bot.json
SOLANA_CLUSTER=mainnet-beta

KAMINO_LENDING_MARKET=7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF
KAMINO_WSOL_RESERVE=d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q

EXECUTION_ENABLED=false
```

On Windows, use an absolute path such as:

```env
KEYPAIR_PATH=C:/Users/YourUser/.config/solana/flash-bot.json
```

### Configuration reference

| Variable                           | Default                                     | Purpose                                                                                         |
| ---------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `RPC_URL`                          | required                                    | HTTPS RPC endpoint used for all mainnet reads, simulations, sends, and receipt queries.         |
| `KEYPAIR_PATH`                     | required except quote-only pair observation | Local Solana CLI-format keypair JSON path. Never commit or share it.                            |
| `SOLANA_CLUSTER`                   | `mainnet-beta`                              | Must remain `mainnet-beta`; other values are rejected.                                          |
| `KAMINO_LENDING_MARKET`            | required                                    | Kamino market public key.                                                                       |
| `KAMINO_WSOL_RESERVE`              | optional safety pin                         | Expected WSOL reserve in that market. Pin it after verifying with `inspect:reserve`.            |
| `STRATEGIES_FILE`                  | `./strategies.json`                         | LST strategy whitelist.                                                                         |
| `PAIR_STRATEGIES_FILE`             | `./pair-strategies.json`                    | Separate pair-observation whitelist.                                                            |
| `JUPITER_API_BASE`                 | Jupiter Lite API                            | HTTPS Jupiter Swap API base URL. A dedicated endpoint/key is recommended for reliable research. |
| `JUPITER_API_KEY`                  | unset                                       | Optional Jupiter API key.                                                                       |
| `ONLY_DIRECT_ROUTES`               | `true`                                      | Restricts Jupiter quotes to direct routes.                                                      |
| `MAX_QUOTE_ACCOUNTS`               | `40`                                        | Jupiter quote account cap.                                                                      |
| `SLIPPAGE_BPS`                     | `25`                                        | Jupiter slippage setting. Review carefully; higher values increase execution risk.              |
| `STRICT_JUPITER_VALIDATION`        | `true`                                      | Rejects suspicious Jupiter instruction content. Keep enabled unless independently audited.      |
| `MAX_FLASH_FEE_BPS`                | `1`                                         | Maximum permitted Kamino flash fee relative to each borrow size.                                |
| `MIN_NET_PROFIT_SOL`               | `0.01`                                      | Minimum expected profit after the configured transaction-cost budget.                           |
| `MAX_TX_COST_SOL`                  | `0.005`                                     | Conservative transaction/rent/priority-fee budget included in the economic gate.                |
| `MIN_GAS_BALANCE_SOL`              | `0.02`                                      | Minimum available wallet SOL required for plans and simulations. Simulation does not spend it.  |
| `COMPUTE_UNIT_LIMIT`               | `1200000`                                   | Compute-unit limit instruction used in constructed plans.                                       |
| `COMPUTE_UNIT_PRICE_MICROLAMPORTS` | `10000`                                     | Priority-fee price used in constructed plans. Include its risk in `MAX_TX_COST_SOL`.            |
| `POLL_MS`                          | `5000`                                      | LST watcher interval.                                                                           |
| `PAIR_POLL_MS`                     | `300000`                                    | Pair-observer interval.                                                                         |
| `PAIR_OBSERVATION_LOG_DIR`         | `./logs/pair-observations`                  | Local JSONL and CSV pair-observation output directory.                                          |
| `EXECUTION_AUDIT_LOG_DIR`          | `./logs/execution-audits`                   | Local finalized LST receipt and balance-reconciliation log directory.                           |
| `EXECUTION_ENABLED`                | `false`                                     | First of two explicit gates required before an LST send.                                        |

Inspect the configured reserve without loading a private key:

```bash
npm run inspect:reserve
```

---

## LST strategy whitelist

`strategies.json` is a public configuration file; it must contain no secrets.

The supplied file includes three execution-mode SPL stake-pool strategies (`mrgnFi LST`, `JitoSOL`, and `bSOL`) plus research candidates in scan-only mode (`compassSOL`, `hSOL`, `pwrSOL`, and `JSOL`). Every entry is re-verified on chain. A candidate can be rejected because its account owner is not the canonical SPL Stake Pool program, its mint differs, a withdrawal authority is required, its epoch data is stale, or its reserve/quote/economics are insufficient.

### Execution strategy example

```json
{
  "id": "marginfi-lst-redemption",
  "enabled": true,
  "mode": "execution",
  "lstMint": "LSTxxxnJzKDFSLr4dUkPcmCf5VyryEqzPLz5j4bpxFp",
  "stakePool": "DqhH94PjkZsjAqEze2BEkWhFQJ6EyU6MdtMphMgnXqeK",
  "borrowAmountsSol": ["0.25", "0.5", "1", "2.5", "5", "10"]
}
```

### Field reference

| Field              | Meaning                                                                               |
| ------------------ | ------------------------------------------------------------------------------------- |
| `id`               | Unique 1–48 character identifier using letters, digits, hyphens, or underscores.      |
| `enabled`          | Whether the strategy is included in scans.                                            |
| `mode`             | `execution` or `scan-only`. Omitted means `execution`.                                |
| `lstMint`          | Expected pool-token mint.                                                             |
| `stakePool`        | Expected stake-pool state account.                                                    |
| `borrowAmountsSol` | Exact decimal strings, not JSON numbers. They are converted to integer WSOL lamports. |

### Adding a strategy safely

1. Start with `"enabled": false` while preparing the entry.
2. Verify the pool account, pool-token mint, owner program, reserve, withdrawal authority, token program, and operational history independently.
3. Use `"mode": "scan-only"` for research candidates.
4. Enable it and observe repeated scans.
5. Promote to `"mode": "execution"` only after you have independently audited the complete transaction path and accept all risk.
6. Keep the total enabled quote load within the parser limit: at most 24 strategies and 64 Jupiter quotes per LST scan.

A scan-only strategy still consumes quote budget after its on-chain prechecks pass, but it is never eligible for transaction construction or sending.

---

## DEX pair observer

`pair-strategies.json` is separate from the LST whitelist. It defines an intermediate mint and two disjoint Jupiter DEX-label allowlists. The default configuration observes selected WSOL/USDC venue pairs and keeps WSOL/USDT entries disabled.

For each configured size, the observer requests two serial exact-in quotes:

```text
leg 1: WSOL → intermediate token using only allowlisted venue A
leg 2: protected minimum output of leg 1 → WSOL using only allowlisted venue B
```

Only protected outputs (`otherAmountThreshold`) are used in the calculation. The optimistic excess of the first quote is not assumed to be available to the second quote.

A pair `GATE PASS` means the protected final WSOL output currently covers:

```text
flash principal + actual flash fee + MAX_TX_COST_SOL + MIN_NET_PROFIT_SOL
```

It is an observation signal only. A pair gate pass permits local pair planning or simulation after a fresh scan, never a send.

Pair observations are written locally as:

```text
PAIR_OBSERVATION_LOG_DIR/
  pair-observations-YYYY-MM-DD.jsonl
  pair-candidates-YYYY-MM-DD.csv
```

The default active pair configuration uses 48 Jupiter requests per full scan. Keep the pair observer slow enough to respect your Jupiter/RPC service limits.

---

## Commands and operating procedure

### Command reference

| Command                            | What it does                                                                                                                        |                         Signs | Broadcasts |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------: | ---------: |
| `npm run scan`                     | Scan all enabled LST strategies and print classification/economics.                                                                 |                            No |         No |
| `npm run plan`                     | Build the best current economic LST execution candidate.                                                                            |                  Yes, locally |         No |
| `npm run simulate`                 | Build and exact-simulate the best current economic LST candidate.                                                                   |                  Yes, locally |         No |
| `npm run simulate:technical`       | Exact-simulate the best structurally valid execution candidate even when it misses the full profit gate.                            |                  Yes, locally |         No |
| `npm run execute -- --yes`         | Scan, build, exact-simulate, send, wait for finality, and audit the best economic LST candidate. Requires `EXECUTION_ENABLED=true`. |                           Yes |        Yes |
| `npm run watch`                    | Re-scan LST candidates on `POLL_MS`; observe/simulate only by default.                                                              | Yes when a candidate is built |         No |
| `npm run watch -- --execute --yes` | Same watcher with the explicitly armed LST execution path.                                                                          |                           Yes |        Yes |
| `npm run scan:pairs`               | Observe pair quotes and write local logs.                                                                                           |                            No |         No |
| `npm run watch:pairs`              | Repeat pair observation on `PAIR_POLL_MS`.                                                                                          |                            No |         No |
| `npm run plan:pairs`               | Locally build a fresh gate-passing pair plan.                                                                                       |                  Yes, locally |         No |
| `npm run simulate:pairs`           | Locally simulate a fresh gate-passing pair plan.                                                                                    |                  Yes, locally |         No |
| `npm run inspect:reserve`          | Inspect the configured Kamino reserve without loading a keypair.                                                                    |                            No |         No |
| `npm run wallet:create`            | Create a local Solana-format hot-wallet keypair.                                                                                    |    Creates local key material |         No |
| `npm run wallet:send-sol -- ...`   | Send SOL from the configured hot wallet only after `--yes`.                                                                         |                           Yes |        Yes |

### Recommended first-run procedure

```bash
# 1. Validate the checkout.
npm run typecheck
npm test
npm run format:check

# 2. Inspect the configured lending reserve without a keypair.
npm run inspect:reserve

# 3. Scan LST candidates. This does not sign or broadcast.
npm run scan

# 4. Observe DEX pair cycles separately. No keypair is loaded.
npm run scan:pairs

# 5. Only if an LST execution candidate is eligible, build it locally.
npm run plan

# 6. Exact-simulate an economically eligible LST candidate. No transaction is sent.
npm run simulate

# 7. If no candidate is economically eligible but one is TECHNICAL ONLY,
#    run the no-send technical validation path.
npm run simulate:technical
```

### Do not jump straight to execution

Only consider the execute command after you have independently reviewed:

- the selected strategy and amount;
- the printed protected output and expected withdrawal;
- the actual flash repayment and dynamic minimum threshold;
- Jupiter route labels and current market conditions;
- exact simulation logs and compute-unit result;
- hot-wallet exposure and the possibility of a failed broadcast fee;
- all program and address assumptions.

The command requires both of these gates:

```env
EXECUTION_ENABLED=true
```

and:

```bash
npm run execute -- --yes
```

The `--yes` flag is deliberately passed after npm's `--` separator.

---

## Technical simulation

`npm run simulate:technical` exists to validate the transaction path without weakening the economic send policy.

It selects only an `execution` strategy that has passed:

- canonical pool-owner, mint, epoch, and permission checks;
- Kamino liquidity and flash-fee checks;
- protected Jupiter quote validation;
- stake-pool reserve checks; and
- protected expected withdrawal sufficient to repay raw principal plus flash fee.

It may still fail the configured transaction-cost/profit margin. Such a candidate appears as `TECHNICAL ONLY` and is never selectable by `plan`, normal `simulate`, `execute`, or `watch --execute`.

The command then:

1. obtains Jupiter swap instructions for the current quote;
2. builds and locally signs the exact Versioned Transaction;
3. simulates the same signed transaction bytes through RPC;
4. uses signature verification and preserves the plan's blockhash; and
5. prints success or program logs without sending anything to the network.

No SOL is deducted by a simulation. It does consume RPC/API requests and can fail if the blockhash expires or state changes before RPC simulation; simply re-scan and rebuild rather than reusing stale output.

---

## Execution audit and balance reconciliation

The LST execution path has post-send verification in addition to its pre-send exact simulation.

After broadcast, the client:

1. waits for `finalized` confirmation;
2. fetches the finalized transaction receipt, retrying the receipt read briefly without rebroadcasting;
3. checks both confirmation error information and `meta.err`;
4. records transaction fee, compute units, and program logs;
5. reads SOL, WSOL ATA, and LST ATA balances before and after execution;
6. calculates raw deltas; and
7. writes a JSONL record in `EXECUTION_AUDIT_LOG_DIR`.

Default path:

```text
logs/execution-audits/lst-execution-audits-YYYY-MM-DD.jsonl
```

An audit record contains public information only:

- signature and finalized slot;
- success/error result;
- transaction fee and compute units;
- program logs;
- strategy and planned protected economics;
- SOL, WSOL, and LST pre/post snapshots;
- raw amount deltas.

It never stores a private key or serialized transaction bytes.

> [!NOTE]
> Balance reconciliation is most meaningful when the hot wallet is dedicated and no other process uses it between the pre-send and post-finality snapshots. LST delta can include leftover tokens from a Jupiter result better than its protected minimum; do not value that residue automatically as SOL profit.

---

## Output interpretation

### `rejected`

A rejection is a normal observation outcome. Read its `Reason` field. Common reasons include:

- stake pool is not owned by the canonical SPL Stake Pool program;
- configured LST mint differs from the pool mint;
- pool epoch state is stale;
- a withdrawal authority is required;
- reserve liquidity is insufficient;
- Jupiter has no acceptable quote;
- expected protected redemption cannot cover raw flash repayment;
- flash fee exceeds the configured relative cap.

### `TECHNICAL ONLY`

This is not an execution signal. It means the candidate may be useful for no-send transaction-path validation, but it does not meet the configured full profitability rule.

### `ELIGIBLE`

This means the candidate passed the scanner's current protected economics. It is still not proof that a send will land or profit. It must be freshly built and simulated, and execution remains separately gated.

### `SCAN ONLY`

This denotes an observed research candidate. It cannot be selected for planning, simulation, or execution, even if its observed economics look favorable.

---

## Hot wallet utilities

Create a Solana CLI-format keypair locally:

```bash
npm run wallet:create
```

The default path is `~/.config/solana/flash-bot.json`. Choose another path with:

```bash
npm run wallet:create -- --output <path>
```

The command refuses to overwrite an existing file and prints only the public address. Do not place a keypair inside the repository.

To transfer SOL from the configured wallet after independently verifying the recipient and amount:

```bash
npm run wallet:send-sol -- --to <RECIPIENT_PUBLIC_KEY> --amount 0.1 --yes
```

By default, the command retains `0.02 SOL` plus a `0.0001 SOL` fee buffer. Use `--keep 0.05` to preserve more SOL. A confirmed transfer cannot be reversed.

---

## Repository map

| Path                          | Responsibility                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`                  | Command parsing, scan output, command orchestration, execution audit reporting.                                           |
| `src/config.ts`               | Strict `.env` parsing, defaults, mainnet pinning, and economic controls.                                                  |
| `src/strategies.ts`           | LST whitelist parser, mode validation, exact decimal parsing, and quote-budget limits.                                    |
| `src/scanner.ts`              | LST pool validation, Jupiter quoting, protected redemption economics, candidate classification, and selection boundaries. |
| `src/stake-pool.ts`           | Canonical SPL stake-pool loading, pool-state checks, conservative withdrawal estimate, and withdrawal instructions.       |
| `src/jupiter.ts`              | Jupiter quote and swap-instruction retrieval plus strict instruction validation.                                          |
| `src/bot.ts`                  | LST transaction construction, exact signed simulation, finalized send handling, and balance snapshots.                    |
| `src/execution-audit-log.ts`  | JSONL serialization and persistence of finalized execution audits.                                                        |
| `src/pair-strategies.ts`      | Pair-observer whitelist parsing and venue separation checks.                                                              |
| `src/pair-scanner.ts`         | Protected two-leg pair observations and economics.                                                                        |
| `src/pair-bot.ts`             | Local-only pair plan construction and simulation; no send API.                                                            |
| `src/pair-observation-log.ts` | Local JSONL/CSV pair observation records.                                                                                 |
| `src/wallet.ts`               | Local keypair loading.                                                                                                    |
| `src/create-wallet.ts`        | Safe local keypair creation utility.                                                                                      |
| `src/send-sol.ts`             | Explicitly gated SOL transfer utility.                                                                                    |
| `strategies.json`             | Public LST strategy whitelist.                                                                                            |
| `pair-strategies.json`        | Public pair-observer whitelist.                                                                                           |
| `test/`                       | Unit tests for parsing, economics, selection safety, simulation/audit behavior, and logging.                              |

---

## Testing

Run all static and unit checks:

```bash
npm run typecheck
npm test
npm run format:check
```

The tests validate local behavior and mocks. They do **not** prove live mainnet liquidity, stake-pool state, Jupiter routes, Kamino behavior, transaction landing, or profitability.

---

## Limitations

- Mainnet-only configuration.
- Public RPC and Jupiter endpoints can rate-limit, fail, return stale data, or differ from production infrastructure.
- The scanner's estimate is conservative, but it is still an estimate based on a changing on-chain state.
- Standard SPL `WithdrawSol` does not include a custom minimum-output argument in this implementation. The project relies on protected LST input, conservative estimates, economic gates, and simulation; state can still move before landing.
- Solana transaction fees may be charged for a broadcast transaction that ultimately fails.
- Priority fees, address lookup tables, account creation, route availability, liquidity, blockhash validity, MEV, slot timing, and state transitions can all affect a real transaction.
- A pair observer `GATE PASS` is research data, never an authorization to execute.
- A successful exact simulation is not a guarantee of a successful or profitable broadcast.
- A finalized successful receipt is evidence for one historical transaction, not evidence of future profitability or safety.

---

## References

- [Kamino flash-loan documentation](https://kamino.com/docs/build/borrow/multiply/flash-loans)
- [Jupiter swap-instructions API](https://dev.jup.ag/docs/swap/build-swap-transaction)
- [SPL Stake Pool documentation](https://spl.solana.com/stake-pool/)
- [Solana web3.js](https://solana-labs.github.io/solana-web3.js/)

---

## Donations

If this research tooling is useful to you, donations are appreciated but never expected.

```text
BTC: bc1pe5eee5eq34czkp2c08uqrdd8d296h8mf04fttwl53aw9pz9n6d0qkmukzm
ETH: 0xE022E11cA86eFd2Aaa75A482B431738b2f45b3d5
SOL: GmkNNLK6dVPAoT3YdbKUXNbANEfHTaEL7NGAsvABZCQJ
```
