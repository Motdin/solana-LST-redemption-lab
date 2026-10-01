# Marginfi LST ↔ Kamino WSOL atomic flash bot

Bot TypeScript ini menyusun **satu transaksi Solana v0 atomik** untuk flow yang diminta:

1. **Flash borrow** — Kamino reserve → searcher: **2.5 WSOL**
2. **Buy swap** — searcher → DEX route: **2.5 WSOL**
3. **Receive swap** — DEX route → searcher: minimal **1.1133 LST**
4. **Crank NAV** — SPL Stake Pool `UpdateStakePoolBalance` (tanpa transfer)
5. **Unstake instan** — stake-pool reserve → searcher: burn **1.1133 LST**, target minimal **3.3119 SOL**
6. **Wrap repayment** — searcher wallet → WSOL ATA, lalu `SyncNative`
7. **Flash repay** — searcher → Kamino reserve: principal + fee on-chain (contoh **2.500025 WSOL** bila fee 0.001%)

`LST` default adalah mint mrgnFi (`LSTxxx…bpxFp`) dan stake-pool default adalah `DqhH…XqeK`. Keduanya **tetap diverifikasi dari state on-chain** sebelum transaksi dibuat.

> [!WARNING]
> Ini adalah perangkat eksekusi DeFi berisiko tinggi, bukan jaminan profit. Gunakan **wallet hot terpisah** yang hanya menyimpan SOL untuk gas/rent. Jangan pernah menyimpan private key pada `.env`, repository, atau log. Flash loan memang atomik—jika repayment gagal, semua state strategy di transaksi juga rollback—tetapi network fee, priority fee, stale quote, account rent, API/routing, dan risiko kontrak tetap ada.

## Proteksi yang diimplementasikan

- **Tidak ada pengiriman default.** `EXECUTION_ENABLED=false` secara default; untuk send diperlukan **dua** gate: env `EXECUTION_ENABLED=true` dan flag `--yes`.
- Menggunakan amount integer `bigint`; tidak ada pembulatan `number` untuk token/SOL.
- Mengambil **fee flash loan dari reserve Kamino on-chain**, bukan mengasumsikan `0.000025`. `MAX_FLASH_FEE_SOL` menolak fee yang lebih tinggi.
- Quote Jupiter wajib `ExactIn`, input harus tepat 2.5 WSOL, dan `otherAmountThreshold` harus cukup untuk LST yang dibakar.
- Mengecek mint stake pool, reserve instant-withdraw, fresh epoch, likuiditas Kamino, saldo gas, fee pool, profit floor, dan minimum withdrawal sebelum build.
- `UpdateStakePoolBalance` dan `WithdrawSol` berada **di tengah transaksi yang sama**. Validator-list stake pool wajib sudah di-crank untuk epoch saat ini; bot menolak state stale daripada mencoba flow yang pasti gagal.
- SOL hasil withdraw diterima wallet lalu hanya sejumlah **repayment tepat** yang ditransfer ke WSOL ATA dan `SyncNative`. Sisa SOL tetap sebagai kandidat profit.
- Jupiter menghasilkan instruction dari API, jadi bot memasang validasi signer dan menolak instruction Jupiter yang mencoba memasukkan System/Stake/Compute Budget/Kamino/Stake Pool program ke route. Gunakan `STRICT_JUPITER_VALIDATION=true` kecuali Anda memahami konsekuensinya.
- Selalu jalankan `simulate` sebelum `execute`; command execute melakukan simulasi lagi langsung sebelum send.

## Persiapan

```bash
npm install
cp .env.example .env
```

Lengkapi minimal berikut di `.env`:

- `RPC_URL`: RPC mainnet yang andal (untuk production gunakan RPC privat/staked).
- `KEYPAIR_PATH`: path ke keypair JSON Solana CLI pada wallet hot.
- `KAMINO_LENDING_MARKET`: market Kamino yang benar-benar berisi reserve WSOL. Nilai ini **sengaja tidak diberi default** agar tidak salah market.
- `KAMINO_WSOL_RESERVE` bersifat opsional. Jika tidak diisi, bot mencari reserve dengan mint WSOL di dalam market tersebut. Setelah market benar, cari dan pin alamat reserve dengan command berikut—command ini tidak membutuhkan `KEYPAIR_PATH` atau private key:

  ```bash
  npm run inspect:reserve
  ```

  Salin output `KAMINO_WSOL_RESERVE=...` ke `.env` untuk mengunci strategi ke reserve yang telah diverifikasi.

Alamat default mrgnFi LST dan stake pool boleh dibiarkan. Jangan menganggap nilai default amount masih profitable hari ini—nilai tersebut adalah flow yang diminta, sedangkan quote, fee, NAV, dan reserve dibaca ulang setiap run.

### Membuat hot wallet tanpa Solana CLI

Jika Solana CLI belum terpasang, Node.js dependency project sudah dapat membuat keypair standard tanpa mengirim secret ke jaringan:

```bash
npm run wallet:create
```

Secara default file dibuat di `~/.config/solana/flash-bot.json`; gunakan `npm run wallet:create -- --output <path>` untuk memilih lokasi lain. Command menolak overwrite file yang sudah ada dan hanya menampilkan public address. Masukkan path yang dicetak ke `KEYPAIR_PATH`, lalu transfer SOL kecil untuk gas. Jangan simpan keypair di folder repo atau membagikan isi file JSON-nya.

## Menjalankan

```bash
# Cek type dan unit test lokal
npm run typecheck
npm test

# Build quote + transaksi saja; tidak simulasi, tidak sign/send ke jaringan
npm run plan

# Build dan simulasi; tidak send
npm run simulate

# Send sekali — hanya setelah simulation dipahami dan EXECUTION_ENABLED=true
npm run execute -- --yes

# Monitor quote tiap POLL_MS, hanya observasi
npm run watch

# Monitor dan execute kandidat yang lulus semua gate
npm run watch -- --execute --yes
```

Output `plan` menampilkan fee flash aktual, minimum output Jupiter, estimasi `WithdrawSol`, batas minimum withdrawal, dan net sebelum biaya network. Jika salah satu preflight tidak memenuhi syarat, bot berhenti dan **tidak** membuat transaksi kirim.

## Catatan flow penting

### Mengapa ada `SyncNative`?

Kamino meminjamkan **WSOL**, sedangkan `WithdrawSol` dari SPL stake pool membayar **native SOL** ke system account wallet. Repayment WSOL mustahil tanpa langkah transfer SOL → WSOL ATA dan `SyncNative`. Langkah ini tidak mengubah ekonomi flow: hanya wrap sebesar `principal + fee` aktual sebelum `flashRepayReserveLiquidity`.

### Mengapa borrow instruction tidak index 0?

Compute budget dan idempotent ATA setup diletakkan lebih dulu agar transaksi dapat berjalan pada wallet baru. Kamino repayment perlu menunjuk index borrow yang tepat; bot menghitung index aktual (biasanya `4`) dan memasukkannya ke instruction repay. Urutan ekonomi tetap borrow → swap → crank → withdraw → repay.

### Crank stake pool

`UpdateStakePoolBalance` hanya refresh total NAV; ia bergantung pada validator list yang sudah updated pada epoch aktif. `UpdateValidatorListBalance` tidak dimasukkan ke flash transaction karena update tersebut memiliki batasan komposisi keamanan pada SPL stake pool. Bila preflight menyebut pool stale, jalankan crank permissionless validator-list terlebih dahulu dalam transaksi terpisah, lalu ulangi simulasi.

### Instant withdrawal bukan selalu tersedia

`WithdrawSol` memakai reserve stake pool. Ia dapat gagal jika reserve tidak memiliki SOL likuid yang cukup atau pool menambahkan authority/aturan baru. Bot mengecek reserve dan authority yang terlihat on-chain, namun simulasi pada slot terbaru tetap adalah keputusan akhir sebelum send.

## Konfigurasi strategi

| Variabel                           |   Default | Makna                                                                          |
| ---------------------------------- | --------: | ------------------------------------------------------------------------------ |
| `FLASH_BORROW_SOL`                 |     `2.5` | Input WSOL exact untuk flash loan dan Jupiter swap                             |
| `MIN_LST_OUT`                      |  `1.1133` | Minimum Jupiter output setelah slippage                                        |
| `LST_TO_BURN`                      |  `1.1133` | LST exact yang dibakar dengan `WithdrawSol`                                    |
| `MIN_WITHDRAW_SOL`                 |  `3.3119` | Target minimum penerimaan SOL dari stake pool                                  |
| `MAX_FLASH_FEE_SOL`                | `0.00003` | Batas maksimum fee Kamino yang diterima                                        |
| `MIN_NET_PROFIT_SOL`               |    `0.01` | Profit minimum sebelum biaya network                                           |
| `MAX_TX_COST_SOL`                  |   `0.005` | Budget network fee yang turut dipakai gate profit                              |
| `ONLY_DIRECT_ROUTES`               |    `true` | Batasi Jupiter ke direct route/pool; set `false` hanya bila memahami multi-hop |
| `COMPUTE_UNIT_LIMIT`               | `1200000` | Compute budget transaksi                                                       |
| `COMPUTE_UNIT_PRICE_MICROLAMPORTS` |   `10000` | Priority fee per CU                                                            |

## Batasan desain

- Mainnet-only; mrgnFi LST stake pool default bukan deployment devnet.
- Jupiter route dapat berubah, jadi API call dilakukan ulang untuk setiap plan; transaksi lama tidak didaur ulang.
- `WithdrawSol` standar SPL stake pool tidak menerima parameter output minimum pada SDK versi ini. Karena itu bot menggunakan beberapa guard (NAV preview konservatif, minimum profit/withdraw gate, quote threshold) dan mewajibkan simulation sebelum send. Tidak ada guard off-chain yang menggantikan audit transaksi/contract sendiri.
- Jangan menonaktifkan strict validation atau menaikkan slippage/priority fee tanpa memahami instruksi V0 dan account lookup table yang dipakai.

## Referensi protokol

- [Kamino flash-loan docs](https://kamino.com/docs/build/borrow/multiply/flash-loans)
- [Jupiter swap-instructions API](https://dev.jup.ag/docs/swap/build-swap-transaction)
- [SPL Stake Pool](https://spl.solana.com/stake-pool/)
