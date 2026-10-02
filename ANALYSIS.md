# Analisis Repo — Solana LST Redemption Lab

**Repo:** `Motdin/solana-LST-redemption-lab` · commit `9093b92` ("flash loan Kamino")
**Tanggal analisis:** 2026-10-02 · **Branch:** `arena/01a0fd2a-solana-lst-redemption-lab`
**Metode:** pembacaan penuh kode (`src/`, `test/`), eksekusi toolchain, dan verifikasi silang terhadap
program on-chain Kamino klend & SPL Stake Pool.

---

## 0. Status perbaikan (revisi 2026-10-02)

F1–F5 dan F13 sudah dikerjakan di branch ini. Ringkasannya:

| Temuan                                     | Status                   | Perubahan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1** top-up repayment menutupi shortfall | ✅ diperbaiki berlapis   | `WithdrawSolWithSlippage` (borsh varian 26) dipakai untuk memasang **floor on-chain**: gate penuh untuk kandidat `ELIGIBLE`, floor principal untuk kandidat `TECHNICAL` (`src/stake-pool.ts`, `src/bot.ts:minimumWithdrawFloorRaw`). Ditambah **rekonsiliasi pasca-final** yang memulihkan hasil redeem nyata dari delta saldo + fee + rent ATA dan menggagalkan (serta menghentikan watcher) bila di bawah gate (`src/bot.ts:reconcileExecutionBalances`, `src/cli.ts`). Konfigurasi `STAKE_POOL_WITHDRAW_SLIPPAGE` (default `true`) sebagai fallback eksplisit |
| **F2** validasi Jupiter longgar            | ✅ diperbaiki            | Validasi jadi allowlist bentuk instruksi: SPL Token hanya `Transfer`/`TransferChecked`/`SyncNative`, ATA hanya `Create`/`CreateIdempotent`, program alur sendiri dilarang, dan **transfer yang mendebit akun output yang dideklarasikan ditolak** (`src/jupiter.ts:validateJupiterInstructions`)                                                                                                                                                                                                                                                                 |
| **F3** audit hilang setelah broadcast      | ✅ diperbaiki            | Audit **parsial** (signature, snapshot pra-kirim, alasan gagal, `partial: true`) ditulis di jalur `catch` sebelum error diteruskan (`src/execution-audit-log.ts`, `src/cli.ts:sendAndAudit`)                                                                                                                                                                                                                                                                                                                                                                     |
| **F4** tanpa timeout/retry                 | ✅ diperbaiki            | `fetchWithBudget`: `AbortController` + timeout per request dan retry berjitter untuk error transport/429/5xx (`JUPITER_TIMEOUT_MS`, `JUPITER_MAX_RETRIES`)                                                                                                                                                                                                                                                                                                                                                                                                       |
| **F5** default whitelist fail-open         | ✅ diperbaiki            | `enabled` dan `mode` kini **wajib** ada; tidak lagi mewarisi hak eksekusi (`src/strategies.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **F10** batas konfigurasi                  | ✅ diperbaiki            | `RPC_URL` wajib https (http hanya loopback), `SLIPPAGE_BPS` dibatasi ≤ 500, `COMPUTE_UNIT_PRICE_MICROLAMPORTS` ≥ 1                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **F11** `watch --execute` tanpa pengaman   | ✅ diperbaiki            | `MIN_SEND_INTERVAL_MS` + `MAX_SENDS_PER_SESSION`; pelanggaran menghasilkan `ExecutionIntegrityError` yang menghentikan loop                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **F13** cakupan tes & CI                   | ✅ sebagian besar        | Tes baru untuk `validateJupiterInstructions`, retry/timeout Jupiter, instruksi berfloor, rekonsiliasi, audit parsial, batas konfigurasi, whitelist eksplisit, dan pair-bot. **56 tes lulus** (dari 32). CI GitHub Actions ditambahkan (`.github/workflows/ci.yml`)                                                                                                                                                                                                                                                                                               |
| **F8** fee berikutnya                      | ✅ diperbaiki (defensif) | Estimator memakai fee tertinggi antara fee aktif dan `nextSolWithdrawalFee`; karena pool stale sudah ditolak, ini murni kehati-hatian                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **F6, F7, F9, F12**                        | ⏳ belum                 | Rent/dust ATA belum masuk gate, audit dependensi belum ditindak, semantik simulasi pair belum diseragamkan, dead code/nama paket belum dibersihkan                                                                                                                                                                                                                                                                                                                                                                                                               |

Verifikasi setelah perubahan: `npm run typecheck` ✅, `npm test` ✅ 56/56, `npm run format:check` ✅.
Verifikasi on-chain (alamat whitelist, DEX label, dukungan `WithdrawSolWithSlippage` di mainnet) tetap
harus dilakukan di lingkungan dengan akses RPC — lihat §6.

---

## 1. Ringkasan eksekutif

Repo ini adalah **research/validation toolkit** (bukan bot produksi) untuk satu pola atomic:
`Kamino flash-borrow WSOL → Jupiter WSOL→LST → SPL Stake Pool WithdrawSol → wrap repayment → flash-repay`,
ditambah **observer DEX pair** (WSOL → stable → WSOL) yang sengaja tidak punya jalur eksekusi.

Kualitas rekayasa di atas rata-rata untuk repo bot Solana: pemisahan modul rapi, ekonomi konservatif
(memakai _protected minimum_, fee dibulatkan ke atas), tiga tingkat status kandidat (`rejected` /
`technical` / `eligible`), dua gerbang eksplisit untuk pengiriman (`EXECUTION_ENABLED=true` **dan** `--yes`),
simulasi persis atas byte yang ditandatangani, serta audit final yang menyimpan delta saldo.
Typecheck, 32 tes, dan pemeriksaan format semuanya hijau.

Temuan utamanya bukan pada "apakah kode berjalan", melainkan pada **beberapa asumsi keselamatan yang
lebih lemah daripada yang tersirat di README**, plus **utang operasional** (tanpa retry/timeout,
tanpa CI, dependency tree besar dengan 20 advisory _high_).

| Aspek                                            | Nilai  | Catatan                                                              |
| ------------------------------------------------ | ------ | -------------------------------------------------------------------- |
| Arsitektur & pemisahan tanggung jawab            | **A−** | modul jelas, boundary `scan → build → simulate → send → audit`       |
| Model ekonomi (konservatif, anti-false-positive) | **A−** | protected minima, `ceil` fee, gate dinamis                           |
| Keamanan operasional (gates, keypair, log)       | **B+** | gate ganda, keypair tidak dimuat di jalur observasi                  |
| Kesiapan mainnet                                 | **C+** | belum ada verifikasi on-chain nyata, tidak ada retry/timeout, F1–F3  |
| Pengujian & CI                                   | **C**  | 32 unit test, tapi titik kritis & e2e tidak teruji, tanpa CI         |
| Higiene dependensi                               | **D**  | 31 vulnerability (20 high) terutama dari `@kamino-finance/klend-sdk` |

---

## 2. Verifikasi yang saya jalankan

| Perintah / pemeriksaan                                                     | Hasil                                                                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                                                   | ✅ 289 paket, tanpa build script gagal                                                                                |
| `npm run typecheck` (`tsc --noEmit`, `strict`, `noUncheckedIndexedAccess`) | ✅ bersih                                                                                                             |
| `npm test` (`vitest run`)                                                  | ✅ **32/32 tes lulus** (12 file)                                                                                      |
| `npm run format:check` (prettier)                                          | ✅ bersih                                                                                                             |
| `npm audit --omit=dev`                                                     | ❌ **31 vulnerability** (11 moderate, **20 high**)                                                                    |
| Grep jalur tandatangan/kirim                                               | ✅ hanya `src/bot.ts` (dan `src/send-sol.ts`) yang menandatangani/mengirim; `pair-*` tidak punya `sendRawTransaction` |
| Cross-check kode on-chain klend (`Kamino-Finance/klend@master`)            | ✅ lihat §5 F14                                                                                                       |
| Verifikasi alamat whitelist / saldo on-chain                               | ⚠️ **tidak bisa** — egress RPC diblokir dari sandbox                                                                  |

---

## 3. Arsitektur & alur

```
CLI (src/cli.ts)  ──scan/plan/simulate/simulate:technical/execute──►  src/scanner.ts ─► src/bot.ts
       │                                                                   │
       ├──scan:pairs / plan:pairs / simulate:pairs / watch:pairs──► src/pair-scanner.ts ─► src/pair-bot.ts
       │
       └──inspect:reserve / wallet:create / wallet:send-sol (utilitas terpisah)
```

Peta modul:

| Modul                                                | Tanggung jawab                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `config.ts`                                          | Parse env → `BotConfig`; pin cluster `mainnet-beta`; tidak menyimpan secret                                      |
| `amount.ts`                                          | Aritmetika bigint eksak (`toAtomic`, `formatAtomic`, `ceilDiv`) — bebas IEEE-754                                 |
| `wallet.ts`                                          | Load keypair JSON format Solana CLI (64 byte), validasi ketat                                                    |
| `strategies.ts` / `pair-strategies.ts`               | Whitelist publik dari JSON dengan batas jumlah entri & validasi duplikat                                         |
| `scanner.ts`                                         | Gate struktural (owner program, mint = poolMint, epoch fresh, izin withdraw), gate ekonomi, klasifikasi kandidat |
| `pair-scanner.ts`                                    | Observasi 2-leg dengan allowlist DEX yang _disjoint_, label rute harus persis                                    |
| `economics.ts`                                       | Fee flash Kamino (`ceil`) + gate dinamis `repayment + MAX_TX_COST_SOL + MIN_NET_PROFIT_SOL`                      |
| `stake-pool.ts`                                      | Estimasi `WithdrawSol` konservatif; bangun `UpdateStakePoolBalance` + `WithdrawSol`                              |
| `jupiter.ts`                                         | Quote + `swap-instructions`; validasi ketat respons                                                              |
| `bot.ts`                                             | Susun tx v0, tanda tangan lokal, simulasi eksak, kirim bergerbang, audit final                                   |
| `execution-audit-log.ts` / `pair-observation-log.ts` | JSONL/CSV lokal (di-`gitignore`), tanpa material rahasia                                                         |
| `token.ts`                                           | ATA idempotent + `SyncNative`                                                                                    |

**Alur instruksi LST** (`src/bot.ts:191-250`) — urutan ini penting dan sudah benar:
`setComputeUnitLimit → setComputeUnitPrice → ATA WSOL idempotent → ATA LST idempotent → flash borrow →
setup Jupiter → swap Jupiter → UpdateStakePoolBalance → WithdrawSol → transfer repayment → SyncNative → flash repay`.
Indeks instruksi borrow dihitung dari panjang array dan diverifikasi ulang (`bot.ts:251-254`).

---

## 4. Yang sudah kuat (jangan diubah tanpa alasan)

1. **Ekonomi konservatif dan eksplisit.** Membakar `otherAmountThreshold` (bukan `outAmount` optimistis) —
   `scanner.ts:186-198`; fee Kamino dibulatkan **ke atas** (`economics.ts:19-30`); fee stake pool dibulatkan
   **ke atas** sementara program on-chain membulatkan ke bawah → estimasi tidak pernah melebih-lebihkan.
2. **Gate berlapis & fail-closed di jalur kirim.** `sendPlan` menolak plan non-ekonomis (`bot.ts:383-386`);
   `simulate:technical` tidak mungkin terkirim karena seleksi terpisah (`scanner.ts:322-393`).
3. **Simulasi yang benar-benar kuat.** `simulatePlan` memakai `sigVerify: true` dan
   `replaceRecentBlockhash: false` (`bot.ts:303-322`), jadi yang disimulasikan adalah byte yang nanti dikirim,
   bukan transaksi rekaan RPC.
4. **Boundary keypair.** Perintah observasi (`scan:pairs`, `watch:pairs`) tidak memuat keypair
   (`cli.ts:96-105`, `config.ts:121-128`) — teruji di `test/config.test.ts`.
5. **Validasi respons agregator.** Menolak `cleanupInstruction`, memaksa `wrapAndUnwrapSol: false` dan
   `dynamicComputeUnitLimit: false` (`jupiter.ts:214-234`); menolak tambahan signer
   (`jupiter.ts:189-195`).
6. **Audit pasca-final.** Mengambil receipt final, retry tanpa rebroadcast, membandingkan
   `meta.err` **dan** `confirmationError`, serta menyimpan delta saldo (`bot.ts:410-473`).
7. **Disiplin data.** Whitelist publik divalidasi keras (maks entri, duplikat id/pool, disjoint venue);
   `logs/` dan `.env` di-`gitignore`; tidak ada `TODO/FIXME` yang menggantung.

---

## 5. Temuan & risiko

Skala: **P0** = bisa kehilangan dana/regresi serius · **P1** = berpotensi merugikan atau memblokir ·
**P2** = ketahanan operasional · **P3** = kebersihan.

### F1 — [P0] Repayment di-_top-up_ dari wallet: shortfall berubah jadi kerugian, bukan revert

`src/bot.ts:233-249` melakukan, sesudah `WithdrawSol`:

```ts
SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wsolAta, lamports: flashRepaymentRaw }),
createSyncNativeInstruction(wsolAta, wsolTokenProgram),
flashRepayIxn,   // menarik principal + fee (+ fee origination) dari wsolAta
```

Karena `WithdrawSol` mencairkan SOL **ke wallet**, lalu wallet mentransfer **sejumlah tetap** `borrow + fee`
ke ATA, maka bila hasil `WithdrawSol` ternyata lebih kecil dari perkiraan, sistem tetap akan menambal
kekurangan dari **saldo SOL pribadi wallet** — selama wallet punya saldo. Transaksi tetap _landed_,
kerugian tercatat sebagai pengurangan saldo wallet, bukan revert. (Saya sudah konfirmasi perilaku on-chain:
`handler_flash_repay_reserve_liquidity.rs` menarik `flash_loan_amount_with_referrer_fee` **dan**
`reserve_origination_fee` dari ATA sumber yang sama.)

Pemicu realistis: pergerakan kurs pool antara scan dan landing, epoch berganti, atau `UpdateStakePoolBalance`
di dalam tx justru **menurunkan** `total_lamports` (reward/fee epoch). `MIN_GAS_BALANCE_SOL=0.02` sama sekali
tidak membatasi besaran ini — potensi kerugian terburuk mendekati ukuran pinjaman.

**Rekomendasi**

- Dokumentasikan sebagai batasan eksplisit di README (bagian _Limitations_) — saat ini tidak disebut.
- Batasi eksposur: ukuran borrow kecil, dan **wallet hot hanya diisi buffer gas**, bukan saldo besar.
- Tambahkan pemeriksaan otomatis pasca-trade: bandingkan `delta.walletSolRaw` dengan
  `expectedNetAfterBudgetRaw`; jika hasil aktual di bawah gate − toleransi → alarm/berhenti otomatis
  (data sudah tersedia di `FinalizedExecutionAudit.delta`, tinggal di-assert).
- Idealnya (butuh verifikasi aturan program stake pool) arahkan hasil `WithdrawSol` **langsung ke ATA WSOL**
  sehingga tidak ada lagi jalur top-up; jika `destination_system_account` wajib system-owned, opsi ini batal
  dan mitigasi di atas tetap wajib.

### F2 — [P0] `STRICT_JUPITER_VALIDATION` terlalu longgar: respons API bisa menyisipkan instruksi Token

`validateJupiterInstructions` (`src/jupiter.ts:170-197`) hanya melarang
`SystemProgram`, `StakeProgram`, `ComputeBudgetProgram`, stake-pool, dan program Kamino. Program
**SPL Token / Token-2022 / ATA tidak dilarang**. Karena proses menandatangani transaksi dengan hot wallet,
respons `/swap-instructions` yang berbahaya (API dikompromikan, MITM, dependensi jahat) dapat menambahkan
misalnya `Transfer`/`Approve`/`CloseAccount` pada token yang **sudah** dimiliki wallet. `strictJupiterValidation`
juga tidak memverifikasi bahwa daftar instruksi/token account sesuai dengan `routePlan` yang dikutip.

**Rekomendasi**

- Ganti _blocklist_ menjadi _allowlist_: hanya program Jupiter swap/route yang diizinkan, plus Token/ATA
  dengan bentuk instruksi yang diperkirakan (mis. hanya `Transfer`, `TransferChecked`, `SyncNative`,
  `CreateIdempotent`) dan account yang diperiksa.
- Nyalakan `STRICT_JUPITER_VALIDATION=true` permanen (jangan jadikan opsi), dan pisahkan wallet:
  wallet eksekusi tidak boleh menyimpan token lain (wallet khusus, hanya SOL + WSOL/LST ATA).

### F3 — [P1] Audit bisa hilang justru setelah transaksi terkirim

`sendAndAudit` (`src/cli.ts:303-338`) hanya membungkus penulisan file dengan `try/catch`. Jika
`auditFinalizedExecution` gagal (mis. RPC error saat `getTransaction`/snapshot saldo), exception naik ke
`main().catch` dan **tidak ada** file audit yang ditulis — padahal transaksi sudah final di chain dan
signature-nya hanya ada di memori.

**Rekomendasi:** simpan `submission.signature` + receipt mentah sebelum/langsung sesudah `sendPlan`,
dan tulis audit parsial (signature, slot, success/error) dalam `finally`; jangan pernah kehilangan jejak tx.

### F4 — [P1] Tidak ada timeout, retry, atau backoff pada Jupiter (dan RPC)

`src/jupiter.ts:101-143` dan `199-265` memanggil `fetch` tanpa `AbortSignal`/timeout, tanpa retry, tanpa
penanganan 429. Konsekuensi: satu 429/5xx/`socket hang` membuat kandidat ter-`rejected` (boros kuota dan
menyembunyikan peluang nyata), `scan:pairs` membatalkan satu siklus, dan fetch yang menggantung bisa
menghentikan `watch` sampai TCP timeout.

**Rekomendasi:** `AbortController` (mis. 5–10 s), retry eksponensial + jitter untuk 429/5xx (maks 3),
dan hitung ulang kuota `MAX_TOTAL_QUOTES` terhadap rate limit `lite-api`.

### F5 — [P1] Default whitelist _fail-open_: `mode` dan `enabled`

`src/strategies.ts:91-92`:

```ts
enabled: value.enabled ?? true,
mode: (value.mode ?? "execution") as LstStrategyMode,
```

Entri yang lupa menulis `mode` otomatis menjadi **`execution`** (bisa masuk `plan/simulate/execute`), dan
yang lupa `enabled` otomatis aktif. Untuk toolkit yang seluruh filosofinya "aman secara default", ini
kebalikan arah.

**Rekomendasi:** default `mode = "scan-only"` dan `enabled = false`, atau wajibkan kedua field
(gagalkan parsing bila tidak ada).

### F6 — [P1] Biaya ATA & dust tidak masuk gate ekonomi; tidak ada reklaim

Gate hanya berisi `repayment + MAX_TX_COST_SOL + MIN_NET_PROFIT_SOL` (`src/economics.ts:37-56`).
Setiap eksekusi dapat membuat 2 ATA (WSOL + LST) dengan rent eksklusif ±0.00204 SOL masing-masing
(`src/bot.ts:191-212`), dan sisa LST dari slippage positif maupun sisa WSOL mengendap di ATA (tidak pernah
di-_close_). Ini bukan kerugian langsung (rent bisa diambil kembali), tetapi _capital lock_ yang tidak
tercermin di angka "expected net" dan tidak pernah dibereskan otomatis.

**Rekomendasi:** masukkan rent ATA baru ke `MAX_TX_COST_SOL`, dan sediakan perintah pembersihan
(`close ATA` / unwrap sisa WSOL) atau minimal laporkan saldo dust di ringkasan audit.

### F7 — [P1] Permukaan supply chain: 31 advisory, 20 di antaranya _high_

`npm audit --omit=dev` melaporkan 31 kerentanan, hampir semuanya transitif dari
`@kamino-finance/klend-sdk` (menarik `farms-sdk`, `kliquidity-sdk`, `scope-sdk`, Orca, Raydium, Pyth,
Anchor) — contoh: `bigint-buffer` (buffer overflow), `toml` (prototype pollution), `axios` (SSRF/CSRF),
`uuid`. Repo ini memuat **keypair hot wallet di proses yang sama**, sehingga satu kompromi dependensi =
kehilangan kunci. Perhatikan juga `node_modules` tidak pernah di-`audit` di CI (karena tidak ada CI).

**Rekomendasi:** jalankan `npm audit --omit=dev` secara berkala, gunakan `overrides` untuk versi yang sudah
ditambal, aktifkan `npm ci --ignore-scripts` di CI, dan pertimbangkan memangkas integrasi Kamino
(untuk kebutuhan flash borrow/repay saja, SDK penuh jelas berlebihan — bandingkan dengan pendekatan
`klend-interface` yang membangun instruksi secara minimal).

### F8 — [P2] Estimasi `WithdrawSol` mengabaikan `nextSolWithdrawalFee`

`src/stake-pool.ts:78-98` hanya membaca `state.solWithdrawalFee`. Program SPL Stake Pool memilih fee
berdasarkan epoch (`sol_withdrawal_fee` vs `next_sol_withdrawal_fee`). Jika pool sudah menjadwalkan fee
lebih tinggi dan program sudah memakainya pada epoch berjalan, estimasi menjadi sedikit optimistis
(kebalikannya: pembulatan `ceilDiv` dan _floor_ pada `gross` justru konservatif — pertahankan).

**Rekomendasi:** pakai `max(fee_sekarang, fee_berikutnya)` atau verifikasi aturan pemilihan fee di
program, lalu catat di komentar. Hal serupa: validasi bahwa `reserveLamports ≥ expectedWithdraw`
(`scanner.ts:214-218`) sudah baik — pertahankan.

### F9 — [P2] Inkonsistensi parameter simulasi antar-jalur

`simulatePlan` memakai `sigVerify: true, replaceRecentBlockhash: false` (`src/bot.ts:303-322`) sedangkan
`simulateFlashPairPlan` memakai `sigVerify: false, replaceRecentBlockhash: true` (`src/pair-bot.ts:256-272`).
Untuk jalur pair (tanpa kirim) ini dapat diterima, tetapi tidak dijelaskan di README dan membuat arti
"simulasi" berbeda antar perintah. **Rekomendasi:** samakan atau beri komentar alasan eksplisit.

### F10 — [P2] Batas konfigurasi longgar

`src/config.ts:140-156`: `SLIPPAGE_BPS` hanya dibatasi ≥ 1 (tanpa batas atas — `5000` akan lolos dan
menggerus seluruh edge sebelum gate ekonomi menolaknya), `MAX_FLASH_FEE_BPS=0` valid (menolak semua
kandidat), `COMPUTE_UNIT_PRICE_MICROLAMPORTS` boleh 0 (transaksi bisa gagal landing di pasar ramai),
dan `RPC_URL` tidak divalidasi sebagai `https://` (padahal `JUPITER_API_BASE` divalidasi ketat).
**Rekomendasi:** batas atas `SLIPPAGE_BPS` (mis. ≤ 500), validasi `RPC_URL` https, dan tolak
`COMPUTE_UNIT_PRICE_MICROLAMPORTS = 0` kecuali `EXECUTION_ENABLED=false`.

### F11 — [P2] `watch --execute` tanpa _rate limit_/kill-switch

`src/cli.ts:465-503`: loop dapat mengirim berulang kali selama kandidat masih lolos gate, tanpa jeda
minimum antar-pengiriman, batas jumlah eksekusi per sesi, atau batas kerugian harian. Gerbang
`EXECUTION_ENABLED`/`--yes` hanya dicek sekali di awal (memang sesuai desain), tetapi tidak ada
pengaman runtime. **Rekomendasi:** `MIN_SEND_INTERVAL_MS`, `MAX_SENDS_PER_SESSION`, dan penghentian
otomatis bila audit terakhir `succeeded=false` atau delta di bawah gate (lihat F1).

### F12 — [P3] Dead code & penamaan

`src/config.ts:9-14` mengekspor `MARGINFI_LST_MINT` dan `MARGINFI_STAKE_POOL` yang **tidak dipakai di
mana pun** (whitelist berasal dari JSON). `package.json.name` masih `marginfi-lst-kamino-flash-bot`
sementara judul repo "Solana LST Redemption Lab". **Rekomendasi:** hapus konstanta mati, samakan nama.

### F13 — [P3] Cakupan tes & tidak ada CI

Titik yang **tidak** teruji padahal kritis:
`getJupiterSwapPlan` + `validateJupiterInstructions` (inti janji "strict validation"),
`buildFlashRedeemPlan` jalur bahagia (urutan instruksi & indeks borrow), `pair-bot`,
`token.ts`, `wallet.ts`, dan tidak ada uji end-to-end terhadap validator lokal.
`.github/` hanya berisi `FUNDING.yml`.

**Rekomendasi:** tambahkan tes unit untuk poin di atas (mudah, semuanya pure/mockable) dan workflow
GitHub Actions: `typecheck` + `vitest` + `prettier --check` + `npm audit --omit=dev` (informational).
Uji e2e (mis. `solana-program-test`/LiteSVM dengan fork mainnet) sangat berharga untuk memvalidasi asumsi
`UpdateStakePoolBalance`/`WithdrawSol` dan urutan instruksi Kamino tanpa uang nyata.

### F14 — [Info, terverifikasi benar] Asumsi on-chain yang saya cek langsung

1. **Tidak perlu instruksi `RefreshReserve` manual.** `handler_flash_borrow_reserve_liquidity.rs`
   memanggil `lending_operations::refresh_reserve(...)` sendiri, dan contoh resmi Kamino juga hanya
   `[flashBorrow, user-ix, flashRepay]`. Alur repo **sama** dan aman di titik ini.
2. **Borrow & repay harus punya daftar akun identik index-per-index** (`flash_borrow_check_matching_repay`).
   SDK 5.1.11 membangun keduanya dalam urutan IDL yang sama (account ke-5 = supply vault, ke-6 = ATA user,
   referrer = `PROGRAM_ID` sebagai sentinel "no referrer" — sama seperti pemakaian internal SDK), sehingga
   pemeriksaan on-chain lolos. ✅
3. **Fee flash dibayar dari ATA yang sama** (`user_source_liquidity`) sebesar principal + referrer fee +
   fee originasi; transfer tunggal `borrow + ceil(fee)` di repo menutup ketiganya selama tidak ada
   perubahan fee antara scan dan landing (jika fee naik → tx gagal, arah yang aman). ✅
4. **Freshness stake pool.** Dokumentasi SPL menyatakan deposit/withdraw gagal bila pool belum
   di-update pada epoch berjalan; repo menambahkan `UpdateStakePoolBalance` di dalam tx dan menolak
   pool stale di scanner (`stake-pool.ts:162-170`) — pendekatan yang benar (dan sengaja lebih ketat,
   karena update dalam tx bisa butuh merge multi-transaksi).
5. **Tidak ada jalur kirim di observer pair** — terverifikasi via grep (`sendRawTransaction` hanya ada di
   `src/bot.ts`). ✅

---

## 6. Catatan yang tidak bisa diverifikasi dari sandbox ini

- Egress RPC diblokir (hanya registry npm & fetch tool web yang bisa), jadi **alamat whitelist di
  `strategies.json`/`pair-strategies.json` tidak saya verifikasi on-chain** — mint/pool di sana adalah
  data yang harus dianggap belum terverifikasi. Penjaga sebenarnya adalah pemeriksaan owner/mint/epoch
  di `scanner.ts`; jalankan `npm run inspect:reserve` dan `npm run scan` di lingkungan dengan RPC.
- Label DEX Jupiter (`Meteora DLMM`, `Raydium CLMM`, `Whirlpool`) hanya divalidasi terhadap respons
  Jupiter, bukan terhadap program on-chain.
- Klaim ekonomi "profit" sepenuhnya bergantung pada kutipan; tidak ada backtest/observasi historis di repo.

---

## 7. Rekomendasi prioritas

**Sekarang (sebelum mainnet uang nyata apa pun)**

1. F2 — perketat validasi Jupiter (allowlist program + bentuk instruksi) dan pakai wallet khusus.
2. F1 — dokumentasikan batas kerugian top-up; isi wallet seminimal mungkin; tambahkan assert delta pasca-trade.
3. F3 — tulis audit parsial agar signature tak pernah hilang.
4. F5 — ubah default menjadi `scan-only`/`enabled=false`.

**Berikutnya (1–2 hari kerja)** 5. F4 — timeout + retry/backoff untuk Jupiter & RPC. 6. F13 — tes untuk `jupiter.validateJupiterInstructions`, `buildFlashRedeemPlan`, `pair-bot`; pasang CI. 7. F10/F11 — batas konfigurasi + rate limit/kill-switch eksekusi. 8. F7 — audit dependensi, `overrides` untuk yang bisa ditambal, pertimbangkan pemangkasan SDK.

**Nanti (research)** 9. F6/F8 — akuntansi rent/dust dan fee stake pool berikutnya. 10. Uji e2e di validator lokal (fork mainnet) untuk memvalidasi urutan instruksi tanpa risiko dana. 11. F12/F9 — bersihkan dead code dan samakan semantik simulasi.

---

## 8. Penutup

Secara desain, repo ini **jauh lebih hati-hati daripada rata-rata bot flash-loan** yang beredar:
konservatif di ekonomi, tegas di batas eksekusi, jujur di README tentang apa yang bisa salah.
Yang membuatnya belum "siap mainnet" bukan aritmetika atau struktur transaksinya (keduanya benar),
melainkan (a) satu celah nyata pada penambalan repayment dari wallet (F1), (b) janji
"strict validation" yang belum setara dengan ancaman yang dihadapi (F2), dan (c) ketahanan operasional
serta higiene dependensi (F3–F7). Menutup F1–F5 sudah cukup untuk menaikkan profil risiko repo ini
dari "eksperimental berbahaya" menjadi "eksperimental yang layak diuji dengan dana kecil".
