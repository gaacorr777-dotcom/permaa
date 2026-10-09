# PERMADEVV Digital Store

## Konfigurasi dan menjalankan

Install Node.js 18 atau lebih baru, lalu dari folder proyek:

```powershell
npm install
Copy-Item config.example.json config.json
# Edit config.json, isi endpoint API, auth.google.clientId/clientSecret, payment.apiKey, provider API keys, dan admin.topupKey
node server.mjs
```

Endpoint API SMM ada di `provider.apiUrl`, endpoint dasar SMSCode di `smscode.apiUrl`, endpoint dasar QRIS di `payment.apiUrl`, dan endpoint OAuth Google di `auth.google`. Timeout, kredensial provider/payment, country ID, markup SMSCode, serta pengaturan server juga dapat diatur di `config.json`. Token SMSCode hanya dibaca dari environment variable. URL override environment tersedia bila diperlukan. `config.mjs` memvalidasi dan membaca pengaturan saat server mulai. File `config.json` lokal diabaikan Git; `config.example.json` adalah template tanpa kredensial. Jangan publikasikan atau kirim file konfigurasi yang sudah berisi rahasia.

Pengaturan tampilan dan kontak berada di `site`: `name`, `tagline`, `description`, `logoUrl`, `faviconUrl`, `themeColor`, `accentColor`, teks hero, `contact.whatsappNumber`, `contact.email`, pesan CS, dan tautan TikTok/Instagram/Facebook. Nomor WhatsApp harus berupa nomor internasional (contoh `62812...`); URL logo/favikon boleh berupa HTTPS atau path lokal seperti `/assets/logo.png`; warna harus hex enam digit. Keuntungan diatur lewat `provider.markupPercent` untuk SMM dan `smscode.markupPercent` untuk SMSCode.

Environment variable dapat dipakai untuk menimpa konfigurasi file: `HOST`, `PORT`, `NODE_ENV`, `TOPUP_ADMIN_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_TIMEOUT_MS`, `DONGTUBE_API_URL`, `DONGTUBE_API_KEY`, `DONGTUBE_TIMEOUT_MS`, `PUSAT_PANEL_API_URL`, `PUSAT_PANEL_API_KEY`, `PUSAT_PANEL_SECRET_KEY`, `PUSAT_PANEL_TIMEOUT_MS`, `SMM_MARKUP_PERCENT`, `SMSCODE_API_URL`, `SMSCODE_TOKEN`, `SMSCODE_TIMEOUT_MS`, `SMSCODE_COUNTRY_ID`, dan `SMSCODE_MARKUP_PERCENT`. Pengguna produksi harus memakai HTTPS dan mengatur `server.nodeEnv` ke `production` agar cookie sesi memakai atribut `Secure`.

Data akun, hash kata sandi, permintaan top-up, pesanan, dan mutasi saldo tersimpan dalam `data/store.json`. File ini dikecualikan dari Git; jangan publikasikan atau bagikan. Simpan cadangannya dengan aman. Backend penyimpanan file ini ditujukan untuk satu instance server; jangan jalankan beberapa instance yang menulis file data yang sama.

## Deploy ke Vercel

Vercel menjalankan frontend sebagai static files dan endpoint backend melalui Vercel Functions di `api/[...path].mjs`. Untuk akun, saldo, dan transaksi digunakan Neon PostgreSQL; penyimpanan lokal `data/store.json` tidak dipakai oleh deployment Vercel.

1. Buat database Neon PostgreSQL dan salin connection string pooled sebagai `DATABASE_URL`.
2. Impor folder proyek ke Vercel (atau hubungkan repository Git). Vercel akan memasang dependensi dari `package.json`; tidak perlu mengubah Build Command.
3. Di **Project Settings → Environment Variables**, tambahkan:
   - `DATABASE_URL` — connection string database Neon.
   - `TOPUP_ADMIN_KEY` — kunci acak panjang untuk endpoint admin.
   - `GOOGLE_CLIENT_ID` dan `GOOGLE_CLIENT_SECRET` — kredensial OAuth Web Client Google.
   - `GOOGLE_REDIRECT_URI` — callback HTTPS, misalnya `https://domain-anda/api/auth/google/callback`.
  - Opsional: `GOOGLE_TIMEOUT_MS` (default `15000`).
   - `DONGTUBE_API_KEY` — API key Dongtube Payment untuk invoice QRIS.
   - Opsional: `DONGTUBE_API_URL` dan `DONGTUBE_TIMEOUT_MS`.
   - `PUSAT_PANEL_API_KEY` dan `PUSAT_PANEL_SECRET_KEY` — kredensial provider; isi keduanya agar katalog/pesanan SMM aktif.
   - Opsional: `PUSAT_PANEL_API_URL`, `PUSAT_PANEL_TIMEOUT_MS`, dan `SMM_MARKUP_PERCENT`.
   - `SMSCODE_TOKEN` — token SMSCode untuk katalog nomor, pembelian, dan OTP.
   - Opsional: `SMSCODE_API_URL`, `SMSCODE_TIMEOUT_MS`, `SMSCODE_COUNTRY_ID`, dan `SMSCODE_MARKUP_PERCENT`.
4. Pilih environment Deployment yang sesuai, simpan variabel, lalu lakukan redeploy.
5. Di Google Cloud Console, daftarkan callback URI yang sama persis pada **Authorized redirect URIs** untuk OAuth Web Client. Setelah deploy, buka `/api/health`; `googleAuthConfigured` menunjukkan kredensial Google tersedia. Schema tabel dibuat otomatis oleh Function saat request pertama. Jangan mengirim kredensial lewat chat atau menaruhnya di file frontend.

Database Neon baru akan kosong. Akun, saldo, top-up, dan pesanan dari `data/store.json` lokal tidak ikut terunggah dan perlu dibuat ulang atau dimigrasikan secara terpisah sebelum situs produksi digunakan.

## Integrasi Pusat Panel SMM

API dipanggil dari backend memakai `provider.apiUrl`. Isi bagian `provider` di `config.json` (jangan meletakkan kredensial di HTML/JavaScript):

```json
"provider": {
  "apiUrl": "https://pusatpanelsmm.com/api/json.php",
  "apiKey": "ISI_API_KEY_DI_SINI",
  "secretKey": "ISI_SECRET_KEY_DI_SINI",
  "timeoutMs": 20000,
  "markupPercent": 0
}
```

Isi `admin.topupKey` dengan kunci acak yang panjang. `server.host` dan `server.port` mengatur alamat server; `server.nodeEnv` mengatur mode cookie. `storage.directory` mengatur lokasi data akun dan transaksi. `provider.timeoutMs` menerima 1000–120000 milidetik dan `provider.markupPercent` menerima 0–10000 (default 0); saat deploy ke Vercel, pertahankan timeout provider di bawah 45000 milidetik agar Function sempat menyimpan hasil sebelum batas eksekusi 60 detik. Harga layanan dari field `price` provider diperlakukan sebagai harga per 1.000 unit; pastikan asumsi harga ini cocok dengan akun provider Anda sebelum menerima transaksi sungguhan.

Katalog SMM dimuat dari aksi `services` dan disimpan di cache server selama lima menit. Pesanan mengirim `service`, tautan target (`data`), `quantity`, serta `komen`/`username` bila diisi. Saldo didebit dengan nominal yang dihitung ulang server sebelum permintaan dikirim. Penolakan eksplisit provider mengembalikan saldo; timeout atau respons yang statusnya tidak pasti **tidak** memicu refund/percobaan ulang otomatis. Dalam kasus itu, jangan buat ulang pesanan—admin harus memeriksa akun provider. Status order yang memiliki ID provider dapat diperiksa dari riwayat Profil.

Isi saldo memakai invoice QRIS Dongtube Payment. API key disimpan hanya di konfigurasi/environment server. Setelah invoice dibayar, status diperiksa melalui riwayat Profil dan saldo dikreditkan satu kali oleh backend; nominal pembayaran yang ditampilkan dapat mencakup biaya gateway, sedangkan saldo bertambah sesuai nominal isi saldo.

Endpoint dasarnya diatur melalui `payment.apiUrl` (default `https://payment.dongtube.cyou`) dan `smscode.apiUrl` (default `https://api.smscode.gg`). API key Dongtube dapat diisi di `payment.apiKey`; token SMSCode tetap melalui environment variable agar tidak tersimpan sebagai rahasia di file.

Untuk server lokal, isi `payment.apiKey` di `config.json` atau atur environment sebelum menjalankan server:

```powershell
$env:DONGTUBE_API_KEY = "API_KEY_DARI_DONGTUBE_PAYMENT"
node server.mjs
```

Nomor kosong dan OTP ditangani oleh integrasi SMSCode di bawah; pesanan SMM ditangani terpisah oleh Pusat Panel SMM.

## Sewa nomor dan OTP SMSCode

Integrasi memakai SDK resmi `@smscode/sdk`. Katalog nomor aktif untuk negara pilihan dimuat dari SMSCode, harga provider dalam IDR ditambah markup, dan harga maksimal provider dibatasi ke harga katalog saat checkout. Token API hanya dibaca dari environment variable; jangan menaruhnya di `config.json`, HTML, JavaScript, atau chat.

Untuk server lokal, atur environment sebelum menjalankan server:

```powershell
$env:SMSCODE_TOKEN = "TOKEN_DARI_DASHBOARD_SMSCODE"
$env:SMSCODE_COUNTRY_ID = "7"
$env:SMSCODE_MARKUP_PERCENT = "20"
node server.mjs
```

Di Vercel, tambahkan variabel yang sama di **Project Settings → Environment Variables**, lalu redeploy. Atur markup sesuai harga jual yang diinginkan; `0` berarti harga provider tanpa markup. Pemesanan menggunakan alur `/v1` SMSCode, sehingga batas `max_price` memakai IDR integer, bukan USD.

Setelah pembelian, nomor tampil di Profil. Tombol **Tunggu OTP** memakai SDK `waitForOtp` dalam potongan polling singkat yang aman untuk serverless hingga maksimal dua menit. Setelah kode diterima dan digunakan di aplikasi tujuan, pilih **Selesai**. Jika perlu kode baru, pilih **Kirim ulang OTP**, lalu tunggu perubahan SMS. Jika belum menerima SMS, pilih **Batalkan**; saldo toko hanya dikembalikan setelah SMSCode mengonfirmasi pembatalan. Kode OTP hanya ditampilkan kepada pemilik pesanan.

## Akun dan saldo

- Daftar dan masuk memakai email serta kata sandi (minimal 8 karakter).
- Masuk dengan Google tersedia setelah `auth.google.clientId`, `clientSecret`, dan `redirectUri` diatur. Callback lokal bawaan adalah `http://localhost:8000/api/auth/google/callback`; pada produksi gunakan HTTPS dan daftarkan URI persis tersebut di Google Cloud Console. Akun dengan email terverifikasi yang sama akan ditautkan ke akun yang sudah ada.
- Kata sandi di-hash dengan PBKDF2; browser menerima cookie sesi `HttpOnly`, `SameSite=Strict`.
- Profil hanya bisa dibuka setelah login. Belanja dan riwayat saldo/pesanan terikat ke akun yang sedang masuk.
- Buat invoice QRIS dari Profil. Saldo **tidak** bertambah sampai gateway mengonfirmasi pembayaran.
- Pembelian memotong saldo di server. Sewa nomor diproses SMSCode; pesanan SMM dikirim ke provider jika kredensial sudah dikonfigurasi.

## Operasi admin top-up dan pesanan

Setel kunci acak rahasia di environment server sebelum menjalankan aplikasi:

```powershell
$env:TOPUP_ADMIN_KEY = "GANTI_DENGAN_KUNCI_ACAK_PANJANG"
node server.mjs
```

Jangan kirim kunci ini ke browser atau pelanggan. Contoh perintah PowerShell untuk melihat permintaan yang menunggu:

```powershell
$headers = @{ "x-admin-key" = $env:TOPUP_ADMIN_KEY }
Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/admin/topups" -Headers $headers
Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/admin/orders" -Headers $headers
```

Permintaan top-up manual lama (status `pending`) dapat disetujui/ditolak memakai ID dari respons daftar. Invoice QRIS baru tidak perlu persetujuan admin:

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8000/api/admin/topups/ID_TOPUP" -Headers $headers -ContentType "application/json" -Body '{"action":"approve"}'
```

Untuk order yang sudah dipenuhi di luar sistem, tandai selesai. Jika dibatalkan, pilih `refund` agar saldo dikembalikan. Untuk status provider yang tidak pasti, periksa panel provider terlebih dahulu sebelum refund agar saldo tidak dikembalikan untuk pesanan yang ternyata sudah dibuat:

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8000/api/admin/orders/ID_ORDER" -Headers $headers -ContentType "application/json" -Body '{"action":"complete"}'
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8000/api/admin/orders/ID_ORDER" -Headers $headers -ContentType "application/json" -Body '{"action":"refund"}'
```

Kunci admin dikirim di header `x-admin-key`; jangan menyimpan perintah/kunci ke kode frontend. Endpoint tersebut ditujukan untuk operator server.

## API

- `GET /api/products` — katalog SMSCode dan layanan SMM (bila kredensial tersedia).
- `GET /api/session` — status login.
- `POST /api/register`, `POST /api/login`, `POST /api/logout` — autentikasi.
- `GET /api/auth/google`, `GET /api/auth/google/callback` — OAuth login Google.
- `GET /api/account` — profil, saldo, riwayat top-up/order/mutasi (harus login).
- `POST /api/topups` — membuat invoice isi saldo QRIS (harus login).
- `GET /api/topups/:id/status` — memeriksa invoice dan mengkredit saldo sekali setelah gateway mengonfirmasi pembayaran (harus login sebagai pemilik invoice).
- `POST /api/orders` — memvalidasi dan memotong saldo; order SMM diteruskan ke provider (harus login).
- `GET /api/orders/:id/status` — meminta status order/OTP dari provider (harus login sebagai pemilik order).
- `POST /api/orders/:id/cancel`, `POST /api/orders/:id/finish`, `POST /api/orders/:id/resend` — membatalkan, menyelesaikan, atau meminta ulang OTP SMSCode setelah status provider mengizinkan (harus login sebagai pemilik order).
- `GET /api/admin/topups`, `POST /api/admin/topups/:id` — verifikasi top-up admin.
- `GET /api/admin/orders`, `POST /api/admin/orders/:id` — pemenuhan/refund order admin.

File yang dibuka langsung melalui `file://` tidak dapat memuat katalog atau memproses transaksi; akun, saldo, dan pembelian memerlukan backend yang dijalankan.
