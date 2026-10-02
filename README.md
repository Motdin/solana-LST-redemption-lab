# Kamino flash-arbitrage scanners

Scanner TypeScript untuk mencari dan mengeksekusi peluang atomik di Solana:

```text
Kamino flash borrow WSOL
→ Jupiter: WSOL → LST
→ SPL Stake Pool: UpdateStakePoolBalance
→ WithdrawSol: burn LST → native SOL
→ wrap exact repayment to WSOL
→ Kamino flash repay
```

Project ini memiliki dua scanner terpisah:

1. **LST redemption** — alur di atas untuk whitelist LST / SPL stake pool di `strategies.json`. Entry `mode: "execution"` dapat dibangun, disimulasikan, dan—hanya dengan gate eksplisit—dikirim; entry `mode: "scan-only"` tetap di-scan tetapi tidak pernah masuk jalur transaksi.
2. **Pair observer** — observasi quote siklus dua venue untuk `WSOL → stablecoin → WSOL` dari `pair-strategies.json`:

```text
Kamino reference: WSOL flash principal + fee
→ Jupiter direct quote pada venue A: WSOL → stablecoin
→ Jupiter direct quote pada venue B: stablecoin → WSOL
→ nilai final minimum dibandingkan dengan repayment + budget
```

`scan:pairs` dan `watch:pairs` **hanya mengambil quote dan membaca state Kamino**. Keduanya tidak memuat keypair, meminta swap instruction, membangun transaksi, melakukan simulation, sign, atau send. Jika—dan hanya jika—quote protected yang baru memenuhi gate ekonomi, `plan:pairs` dapat membangun/sign lokal dan `simulate:pairs` dapat menjalankan simulation. Tidak ada command pair untuk send. Ia bukan scanner token bebas; seluruh mint dan label DEX harus ada pada allowlist publik yang Anda verifikasi sendiri.

> [!WARNING]
> Ini adalah software DeFi berisiko tinggi dan bukan jaminan profit. Pakai hot wallet terpisah dengan SOL terbatas untuk fee/rent. Jangan pernah membagikan seed phrase atau isi file keypair JSON. Semua execution mainnet adalah tanggung jawab operator.

## Empat tahap yang tersedia

1. **Dynamic scanner, watch-only** — quote beberapa ukuran flash loan untuk mrgnFi LST dan menghitung output redemption terbaru.
2. **Whitelist multi-pool** — tambahkan LST / SPL stake pool terverifikasi ke `strategies.json`.
3. **Simulasi kandidat terbaik** — hanya kandidat `mode: "execution"` dengan `net >= MIN_NET_PROFIT_SOL` yang dibangun dan disimulasikan.
4. **Execution bergated** — send hanya ketika kandidat terbaik LST `mode: "execution"` lulus scanner, build, simulation, `EXECUTION_ENABLED=true`, dan flag `--yes`.
5. **DEX pair observer** — scan read-only `WSOL → stablecoin → WSOL` pada dua venue Jupiter yang disjoint; candidate yang lulus gate dapat di-build/simulate lokal, tanpa command execution.

Tidak ada `MIN_LST_OUT`, `LST_TO_BURN`, atau `MIN_WITHDRAW_SOL` statis. Scanner LST memakai **Jupiter `otherAmountThreshold`** sebagai jumlah LST yang dibakar, lalu menghitung kembali NAV/withdraw fee stake pool. Pair observer memakai threshold leg pertama sebagai input leg kedua dan hanya menilai threshold WSOL akhir. Keduanya memakai gate dinamis:

```text
minimum protected final WSOL output =
  flash principal
  + flash fee Kamino aktual
  + MAX_TX_COST_SOL
  + MIN_NET_PROFIT_SOL
```

Dengan begitu nominal yang tidak lagi masuk akal di state terbaru—misalnya 1.1133 LST yang hanya dapat diredeem menjadi 1.718 SOL—akan ditolak tanpa transaksi dikirim.

## Proteksi utama

- Integer token/SOL menggunakan `bigint`, tanpa pembulatan `number`.
- Kamino reserve, liquidity, dan flash fee dibaca ulang pada setiap scan.
- Quote Jupiter harus exact-in WSOL → mint LST yang ada di whitelist.
- Candidate membakar output LST **minimum yang terlindungi slippage**, bukan quote optimistis.
- Memeriksa mint pool, freshness epoch, withdrawal authority, instant reserve liquidity, flash fee relative (`MAX_FLASH_FEE_BPS`), dan profit setelah budget biaya.
- Memakai `UpdateStakePoolBalance` sebelum `WithdrawSol` di transaksi atomik.
- Sol hasil redeem diterima wallet, lalu hanya nominal repayment aktual yang di-wrap sebagai WSOL untuk Kamino; sisanya adalah kandidat profit.
- Menolak Jupiter instruction dengan signer tambahan atau System/Stake/ComputeBudget/Kamino/Stake Pool program bila `STRICT_JUPITER_VALIDATION=true`.
- `watch` default observe-only. Execution butuh dua gate eksplisit.

## Install dan konfigurasi

```bash
npm install
cp .env.example .env
```

Di Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Isi `.env` minimal:

```env
RPC_URL=https://RPC_MAINNET_ANDA
KEYPAIR_PATH=C:/Users/Anda/.config/solana/flash-bot.json
KAMINO_LENDING_MARKET=7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF
KAMINO_WSOL_RESERVE=d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q
EXECUTION_ENABLED=false
```

Pair observer memakai file default `./pair-strategies.json`; ubah hanya jika Anda membutuhkan file allowlist terpisah:

```env
PAIR_STRATEGIES_FILE=./pair-strategies.json
PAIR_POLL_MS=300000
PAIR_OBSERVATION_LOG_DIR=./logs/pair-observations
```

`scan:pairs` dan `watch:pairs` hanya membutuhkan `RPC_URL`, market/reserve Kamino, serta konfigurasi Jupiter. Keduanya tidak membaca `KEYPAIR_PATH`. `plan:pairs` dan `simulate:pairs` membutuhkan keypair untuk signature lokal dan tetap memeriksa `MIN_GAS_BALANCE_SOL`; keduanya tidak dapat mengirim transaksi. `KEYPAIR_PATH` juga tetap diperlukan untuk command LST `scan`, `plan`, `simulate`, `execute`, dan `watch`.

`KAMINO_WSOL_RESERVE` adalah optional safety pin. Untuk memverifikasi reserve dari market tanpa private key:

```bash
npm run inspect:reserve
```

## Whitelist strategi

`strategies.json` adalah file publik tanpa secret. Default memasukkan tiga pool SPL stake-pool execution (`mrgnFi LST`, `JitoSOL`, dan `bSOL`) serta empat kandidat riset scan-only (`compassSOL`, `hSOL`, `pwrSOL`, dan `JSOL`). Semua tetap diverifikasi on-chain pada setiap scan. Jika pemilik account pool bukan program SPL stake-pool, suatu pool memasang authority `WithdrawSol`, data epoch-nya stale, mint/pool tidak cocok, atau reserve SOL-nya tidak cukup, scanner hanya menandainya `rejected`.

Contoh entry execution:

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

Untuk kandidat yang ingin tetap diukur tanpa pernah membangun transaksi, gunakan `"mode": "scan-only"`. Candidate scan-only mengikuti pipeline normal tanpa bypass: validasi mint pool dan owner program SPL stake-pool, izin `WithdrawSol` permissionless, freshness epoch, reserve, lalu—hanya setelah pemeriksaan on-chain itu lulus—quote Jupiter, fee, dan gate ekonomi. Bila lolos ekonomi, tabel CLI menampilkan status **`SCAN ONLY`**. Ia tetap tidak dapat dipilih oleh `plan`, `simulate`, `execute`, atau `watch --execute`; builder juga menolak langsung sebagai pertahanan berlapis.

`mode` hanya menerima `"execution"` atau `"scan-only"`. Entry lama yang tidak memiliki `mode` tetap kompatibel dan diperlakukan sebagai `"execution"`.

Untuk tahap 2, tambahkan object baru ke array `strategies`. Setiap entry harus mempunyai:

- `id` unik;
- `lstMint` yang benar;
- `stakePool` SPL Stake Pool yang benar;
- `borrowAmountsSol` sebagai string decimal;
- `mode: "scan-only"` untuk kandidat riset atau `mode: "execution"` hanya setelah alur transaksi diaudit;
- `enabled: true` hanya setelah pool/mint diverifikasi.

Scanner membatasi maksimal 24 strategi dan 64 quote per putaran untuk menghindari request tak terkendali. Jangan memasukkan mint atau pool yang tidak Anda audit.

## Observasi pair DEX (tanpa transaksi)

`pair-strategies.json` terpisah dari whitelist LST. Default yang **aktif** memantau enam arah `WSOL/USDC` di Meteora DLMM, Raydium CLMM, dan Whirlpool: setiap pasangan venue diamati pada kedua arah. Dua entry `WSOL/USDT` tetap tersedia tetapi dinonaktifkan karena observasi awal menunjukkan price impact yang jauh lebih buruk. Kedua leg dipaksa memakai venue yang **disjoint**; entry yang memasang label DEX sama di kedua sisi akan ditolak saat file dibaca.

Untuk setiap nominal, observer mengambil quote ExactIn berikut secara serial:

```text
leg 1: WSOL → intermediate token pada DEX allowlist A
leg 2: protected minimum output leg 1 → WSOL pada DEX allowlist B
```

Hanya `otherAmountThreshold` dari kedua quote yang dipakai. Output final protected dibandingkan dengan:

```text
flash principal + Kamino fee aktual + MAX_TX_COST_SOL + MIN_NET_PROFIT_SOL
```

Kelebihan output aktual leg pertama di atas minimum tidak dihitung sebagai profit; ini menjaga hasil observasi konservatif. `GATE PASS` berarti dua quote minimum saat itu menutup formula ekonomi. Ini hanya membuka `plan:pairs` dan `simulate:pairs`, yang memaksa scan ulang, memakai threshold yang sama di Jupiter instruction, dan tidak memiliki jalur send. Itu **bukan** tanda siap eksekusi.

Batas default adalah 64 request Jupiter per putaran (dua quote per candidate). Default aktif memakai 48 request per `scan:pairs`; `watch:pairs` menunggu `PAIR_POLL_MS` (default 5 menit) setelah satu putaran selesai agar tidak membanjiri public API. Tambahkan pair/mint/DEX lain hanya setelah memverifikasi mint, token program, likuiditas, dan label DEX Jupiter. Token-2022 sengaja ditolak pada fase observer ini agar transfer-fee atau extension token tidak membuat hitungan quote tidak lengkap.

Setiap hasil scan juga disimpan lokal ke `PAIR_OBSERVATION_LOG_DIR` sebagai dua file per hari UTC:

```text
pair-observations-YYYY-MM-DD.jsonl  # satu record lengkap per putaran scan
pair-candidates-YYYY-MM-DD.csv      # satu baris per candidate
```

CSV memuat protected/optimistic quote output, venue, price impact, gross round-trip, flash fee, repayment, threshold minimum, dan net setelah budget. JSONL menyimpan record lengkap beserta raw atomic amount. Direktori `logs/` diabaikan Git dan tidak berisi keypair, signature, instruction, maupun transaction payload.

## Hot wallet tanpa Solana CLI

Project dapat membuat keypair format Solana CLI dari Node.js lokal:

```bash
npm run wallet:create
```

Default path adalah `~/.config/solana/flash-bot.json`; pilih path lain dengan:

```bash
npm run wallet:create -- --output <path>
```

Command menolak overwrite file yang sudah ada dan hanya mencetak public address. Isi `KEYPAIR_PATH` dengan path itu. Kirim SOL kecil—default bot memerlukan minimal `0.02 SOL` sebagai rent/fee reserve. Jangan simpan keypair dalam folder repo atau membagikan isi JSON-nya.

## Command operasional

```bash
# Cek type dan test
npm run typecheck
npm test

# Tahap 1–2: tampilkan seluruh candidate whitelist LST; tidak sign/send
npm run scan

# Phase 5a: observasi pair DEX. Hanya quote + state Kamino: tidak memuat keypair,
# tidak meminta instruction, tidak build/simulate/sign/send. Hasil dicatat ke CSV + JSONL lokal.
npm run scan:pairs
npm run watch:pairs

# Phase 5b: hanya jika scan yang baru menghasilkan GATE PASS. Membuat transaction
# ter-sign lokal untuk inspeksi atau simulation, tetapi tidak memiliki send path.
npm run plan:pairs
npm run simulate:pairs

# Build candidate LST paling menguntungkan; tidak simulate/send
npm run plan

# Tahap 3: build + simulate top candidate; tidak send
npm run simulate

# Monitor berulang, observe-only
npm run watch

# Tahap 4: hanya setelah setup matang dan EXECUTION_ENABLED=true
npm run execute -- --yes
# atau monitor+execute top candidate yang lulus
npm run watch -- --execute --yes
```

`scan` dapat menampilkan banyak `rejected` candidate. Itu adalah hasil normal ketika redemption tidak menutup repayment atau quote tidak tersedia. Candidate `ELIGIBLE` baru berarti layak dibangun; masih harus lulus simulation sebelum send.

## Mengirim profit SOL

Profit aktual tetap berada pada hot wallet bot. Untuk transfer ke wallet penerima tanpa mengungkapkan keypair:

```bash
npm run wallet:send-sol -- --to <PUBLIC_ADDRESS_PENERIMA> --amount 0.1 --yes
```

Command membaca `RPC_URL` dan `KEYPAIR_PATH`, memeriksa saldo, lalu secara default menyisakan `0.02 SOL` dan fee buffer `0.0001 SOL`. Tambahkan `--keep 0.05` untuk menyisakan lebih banyak SOL. Transfer yang confirmed tidak dapat dibatalkan—periksa public address dan amount sebelum memakai `--yes`.

## Batasan penting

- Mainnet-only.
- Pair strategy sengaja tidak memiliki execution/send command, bahkan bila `EXECUTION_ENABLED=true` atau `--yes` diberikan. Hanya `plan:pairs` dan `simulate:pairs` yang tersedia, dan keduanya membutuhkan `GATE PASS` dari scan baru.
- Pair observer membandingkan dua quote pada waktu berbeda. Perubahan slot, quote expiry, MEV, dan slippage berarti `GATE PASS` adalah sinyal riset; simulation terbaru adalah pemeriksaan berikutnya, bukan peluang yang dapat langsung dieksekusi.
- `WithdrawSol` memakai stake-pool reserve dan dapat gagal bila reserve tidak cukup, bahkan jika preview sebelumnya cukup; simulasi terbaru adalah validasi terakhir sebelum send.
- SPL `WithdrawSol` versi standar pada SDK ini tidak membawa minimum-output parameter on-chain. Bot menggunakan quote minimum, estimasi konservatif, gate profit, dan full simulation; tetap ada risiko perubahan state antara simulation dan landing.
- Quote profitable bukan jaminan transaction landing. Priority fee, account size, MEV, liquidity, dan state slot bisa berubah.
- Jangan menonaktifkan strict validation atau menaikkan slippage/fee tanpa memahami konsekuensinya.

## Referensi

- [Kamino flash-loan docs](https://kamino.com/docs/build/borrow/multiply/flash-loans)
- [Jupiter swap-instructions API](https://dev.jup.ag/docs/swap/build-swap-transaction)
- [SPL Stake Pool](https://spl.solana.com/stake-pool/)
