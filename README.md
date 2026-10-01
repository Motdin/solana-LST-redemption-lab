# Kamino WSOL → LST redemption arbitrage scanner

Scanner TypeScript untuk mencari dan mengeksekusi peluang atomik di Solana:

```text
Kamino flash borrow WSOL
→ Jupiter: WSOL → LST
→ SPL Stake Pool: UpdateStakePoolBalance
→ WithdrawSol: burn LST → native SOL
→ wrap exact repayment to WSOL
→ Kamino flash repay
```

Project ini dimulai dengan mrgnFi LST (`LSTxxx…bpxFp`) dan mendukung **whitelist beberapa LST / SPL stake pool** melalui `strategies.json`. Ia bukan scanner token bebas; hanya pool yang Anda verifikasi sendiri akan disentuh.

> [!WARNING]
> Ini adalah software DeFi berisiko tinggi dan bukan jaminan profit. Pakai hot wallet terpisah dengan SOL terbatas untuk fee/rent. Jangan pernah membagikan seed phrase atau isi file keypair JSON. Semua execution mainnet adalah tanggung jawab operator.

## Empat tahap yang tersedia

1. **Dynamic scanner, watch-only** — quote beberapa ukuran flash loan untuk mrgnFi LST dan menghitung output redemption terbaru.
2. **Whitelist multi-pool** — tambahkan LST / SPL stake pool terverifikasi ke `strategies.json`.
3. **Simulasi kandidat terbaik** — hanya kandidat dengan `net >= MIN_NET_PROFIT_SOL` yang dibangun dan disimulasikan.
4. **Execution bergated** — send hanya ketika kandidat terbaik lulus scanner, build, simulation, `EXECUTION_ENABLED=true`, dan flag `--yes`.

Tidak ada `MIN_LST_OUT`, `LST_TO_BURN`, atau `MIN_WITHDRAW_SOL` statis. Untuk setiap kandidat scanner memakai **Jupiter `otherAmountThreshold`** sebagai jumlah LST yang dibakar, lalu menghitung kembali NAV/withdraw fee stake pool. Gate dinamis adalah:

```text
minimum WithdrawSol output =
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

`KAMINO_WSOL_RESERVE` adalah optional safety pin. Untuk memverifikasi reserve dari market tanpa private key:

```bash
npm run inspect:reserve
```

## Whitelist strategi

`strategies.json` adalah file publik tanpa secret. Default hanya berisi mrgnFi LST:

```json
{
  "strategies": [
    {
      "id": "marginfi-lst-redemption",
      "enabled": true,
      "lstMint": "LSTxxxnJzKDFSLr4dUkPcmCf5VyryEqzPLz5j4bpxFp",
      "stakePool": "DqhH94PjkZsjAqEze2BEkWhFQJ6EyU6MdtMphMgnXqeK",
      "borrowAmountsSol": ["0.25", "0.5", "1", "2.5", "5", "10"]
    }
  ]
}
```

Untuk tahap 2, tambahkan object baru ke array `strategies`. Setiap entry harus mempunyai:

- `id` unik;
- `lstMint` yang benar;
- `stakePool` SPL Stake Pool yang benar;
- `borrowAmountsSol` sebagai string decimal;
- `enabled: true` hanya setelah pool/mint diverifikasi.

Scanner membatasi maksimal 24 strategi dan 64 quote per putaran untuk menghindari request tak terkendali. Jangan memasukkan mint atau pool yang tidak Anda audit.

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

# Tahap 1–2: tampilkan seluruh candidate whitelist; tidak sign/send
npm run scan

# Build candidate paling menguntungkan; tidak simulate/send
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
- `WithdrawSol` memakai stake-pool reserve dan dapat gagal bila reserve tidak cukup, bahkan jika preview sebelumnya cukup; simulasi terbaru adalah validasi terakhir sebelum send.
- SPL `WithdrawSol` versi standar pada SDK ini tidak membawa minimum-output parameter on-chain. Bot menggunakan quote minimum, estimasi konservatif, gate profit, dan full simulation; tetap ada risiko perubahan state antara simulation dan landing.
- Quote profitable bukan jaminan transaction landing. Priority fee, account size, MEV, liquidity, dan state slot bisa berubah.
- Jangan menonaktifkan strict validation atau menaikkan slippage/fee tanpa memahami konsekuensinya.

## Referensi

- [Kamino flash-loan docs](https://kamino.com/docs/build/borrow/multiply/flash-loans)
- [Jupiter swap-instructions API](https://dev.jup.ag/docs/swap/build-swap-transaction)
- [SPL Stake Pool](https://spl.solana.com/stake-pool/)
