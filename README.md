# sholat-monitor

Daemon yang mengingatkan waktu sholat di Semarang, dengan jadwal yang **sama
persis** dengan [shalat.landak.com](https://shalat.landak.com/?kota=Semarang) —
bukan "mirip".

Tujuan utamanya satu: **jangan sampai sholat terlewat**. Karena itu channel
utamanya adalah notifikasi desktop yang merebut perhatian (bukan toast kecil di
pojok yang bisa terlewat), ditambah toast di dalam TUI OpenCode dan widget di
Luvus Bar.

---

## Apa yang berjalan

```
                    ┌──────────────────────────────┐
                    │  systemd --user              │
                    │  sholat-monitor.service      │
                    │  Restart=always              │
                    └──────────────┬───────────────┘
                                   │ tiap 60 detik
                                   ▼
                    ┌──────────────────────────────┐
                    │  bin/sholat run              │
                    │  plan() → deliver()          │
                    └───┬───────┬────────┬─────────┘
                        │       │        │
          ┌─────────────┘       │        └──────────────┐
          ▼                     ▼                       ▼
  ┌───────────────┐   ┌──────────────────┐   ┌──────────────────┐
  │ notify-send   │   │ alert.json       │   │ luvus bar push   │
  │ (desktop)     │   │ → plugin TUI     │   │ → widget di bar  │
  └───────────────┘   └──────────────────┘   └──────────────────┘
```

Setiap channel **independen**: kalau satu gagal, yang lain tetap dikirim.

---

## Jadwal = jadwal landak

Halaman landak menjalankan `PrayTimes.js` dengan setelan tertentu. Kita
memakai **file yang sama** (di-*vendor* ke `vendor/PrayTimes.js`, bukan
dependency npm) dengan setelan yang sama persis:

```js
prayTimes.adjust({ fajr: 20, dhuhr: '2 min', maghrib: 1, isha: 18 })
prayTimes.tune({ fajr: 1, sunrise: -2, asr: 2, maghrib: 2, isha: 1 })
prayTimes.getTimes(tgl, [-6.9666667, 110.4166667], "7", 0, "24h")
```

Semua angka ini bisa diubah lewat `config.json`; selama tidak diubah, hasilnya
identik dengan situs. Contoh untuk 7 Oktober 2026:

| | Shubuh | Dzuhur | Ashar | Maghrib | Isya |
|---|---|---|---|---|---|
| sholat-monitor | 04:04 | 11:28 | 14:32 | 17:35 | 18:43 |

Sekali sehari daemon membandingkan `vendor/PrayTimes.js` dengan yang ada di
server landak. Kalau upstream berubah, itu dicatat di log — angka kita baru
ikut berubah setelah file lokal diperbarui (`sholat sync`).

> **Catatan TLS:** server landak melayani HTTPS dengan DH key yang terlalu kecil
> untuk OpenSSL modern, jadi Node gagal (`ERR_SSL_DH_KEY_TOO_SMALL`). Karena itu
> sinkronisasi memakai `http://` polos, sama seperti yang dilakukan halaman itu
> sendiri, lalu dibuktikan dengan perbandingan SHA-256.

---

## Pasang

Butuh Node.js 18+ dan `notify-send`.

```sh
cd ~/projects/sholat-monitor
node bin/sholat doctor     # cek semua prasyarat
node bin/sholat install    # pasang + nyalakan systemd --user service
```

`install` menyalin unit ke `~/.config/systemd/user/`, menjalankan
`enable --now`, dan mengaktifkan **linger** supaya daemon tetap jalan setelah
logout — bukan hanya selama sesi login.

Widget Luvus Bar dideklarasikan oleh module `sholat.bar` di `luvus-bar/`, yang
dipasang dengan `luvus module link` (sekali saja).

---

## Perintah

```
sholat today            jadwal hari ini + besok
sholat next             sholat berikutnya, JSON
sholat run              jalankan daemon di foreground
sholat once             satu tick saja (untuk cron atau pemicu manual)
sholat test [--lead N]  picu semua channel dengan alert palsu
sholat sync             bandingkan/tarik ulang engine dari landak
sholat status           state daemon + snapshot
sholat doctor           cek semua prasyarat
sholat install          pasang + nyalakan service systemd user
sholat log              tail log daemon
```

Uji coba notifikasi tanpa menunggu waktu sholat:

```sh
sholat test 5     # alert palsu H-5 ke semua channel yang aktif
sholat test 15    # H-15, levelnya info
```

---

## Bertahan dari restart

Tiga hal yang membuatnya tahan:

1. **`Restart=always`** — kalau prosesnya mati (crash, `kill -9`, reboot),
   systemd menyalakannya lagi setelah 10 detik.
2. **`loginctl enable-linger`** — service user tetap hidup walau kamu logout.
3. **State di disk** — setiap tick disimpan ke
   `~/.local/state/sholat-monitor/daemon-state.json`, termasuk daftar alert yang
   sudah dipicu. Setelah restart, daemon **tidak** memicu ulang alert yang sudah
   lewat, dan tidak meledak sekaligus.

Tentang restart, ada dua perilaku yang disengaja:

- **Masih dalam toleransi** (`alerts.lateToleranceMinutes`, bawaan 20 menit):
  alert yang terlewat tetap berbunyi. Jadi kalau daemon baru hidup 5 menit
  sebelum sholat, kamu tetap diberi tahu.
- **Sudah lewat toleransi**: alert dianggap terlewat dan **tidak** dipicu.
  Tidak ada gunanya memberi tahu sesuatu yang sudah lewat 40 menit.
- **Kalau beberapa alert jatuh tempo sekaligus** (mis. hidup 5 menit sebelum
  sholat, sehingga H-15 dan H-5 dua-duanya telat): hanya yang **paling mendesak**
  yang berbunyi. Sisanya dicatat sebagai `didahului`.

State yang lebih dari 3 hari dibuang otomatis, dan log diputar sendiri di
2 MB — daemon ini dirancang untuk jalan berbulan-bulan.

---

## Channel

| Channel | Cara kerja | Bawaan |
|---|---|---|
| `desktop` | `notify-send` — notifikasi GNOME yang muncul di layar | **aktif** |
| `opencode` | menulis `alert.json`, dibaca plugin TUI OpenCode | **aktif** |
| `luvusBar` | repaint widget "Waktu Sholat" di bar Luvus | **aktif** |
| `sound` | memutar adhan dari server landak | **nonaktif** |

**Kenapa desktop yang utama.** Toast di dalam TUI hanya kelihatan kalau TUI
sedang aktif. Notifikasi desktop muncul di atas semua window, dan saat mendekati
waktu sholat (≤ `criticalAtMinutes`) dikirim sebagai `urgency=critical` sehingga
**tidak hilang sendiri**.

**Kenapa suara nonaktif secara bawaan.** Suara adalah satu-satunya channel yang
benar-benar merebut perhatian. Itu bagus saat kamu di meja, buruk kalau jam 4
pagi. Nyalakan kalau memang mau (`channels.sound.enabled`), atau pakai
`quiet` untuk membungkam jam-jam tertentu.

### Routing ke TUI OpenCode

Daemon tidak tahu terminal mana yang sedang kamu lihat. Luvus tahu. Jadi:

1. Daemon bertanya `luvus pane list` → dapat pane yang sedang fokus.
2. Pane itu ditulis ke `alert.json`.
3. Plugin TUI membandingkannya dengan `LUVUS_PANE_ID` miliknya sendiri.

Hasilnya: **hanya TUI yang sedang kamu lihat yang menampilkan toast**, bukan
semua TUI yang terbuka. Kalau Luvus tidak bisa dihubungi, alert tetap ditulis
tanpa target dan semua TUI menampilkannya (lebih baik berisik daripada tidak
sampai).

Plugin TUI dipasang di `~/.config/opencode/sholat-alert/` dan didaftarkan di
`cli.json` pada key `plugins`.

---

## Konfigurasi

Semua di `config.json`. File ini **boleh dikomentari** (JSONC). Setelah mengubah:

```sh
sholat doctor                       # pastikan tidak ada yang salah tulis
systemctl --user restart sholat-monitor
```

### `location`

| Kunci | Arti | Bawaan |
|---|---|---|
| `kota` | nama kota, dipakai di teks notifikasi | `"Semarang"` |
| `lat`, `lng` | koordinat | `-6.9666667`, `110.4166667` |
| `tz` | offset jam dari UTC | `7` (WIB) |

### `params` — parameter perhitungan

| Kunci | Arti | Bawaan |
|---|---|---|
| `method` | metode standar: `MWL`, `ISNA`, `Egypt`, `Karachi`, `UmmAlQura`, `Dubai`, `Qatar`, `Kuwait`, `Singapore`, `Turkey`, `Tehran` | `"MWL"` |
| `imsak` | jeda sebelum Shubuh | `"10 min"` |
| `fajr` | sudut Shubuh di bawah horizon (derajat) | `20` |
| `isha` | sudut Isya di bawah horizon (derajat) | `18` |
| `maghrib` | sudut Maghrib di bawah horizon (derajat) | `1` |
| `dhuhr` | jeda aman sesudah zenith | `"2 min"` |
| `asr` | `"Standard"` (Syafi'i/Maliki/Hanbali) atau `"Hanafi"` | `"Standard"` |
| `highLats` | aturan lintang tinggi: `NightMiddle`, `AngleBased`, `OneSeventh`, `None` | `"NightMiddle"` |

### `tune` — penyesuaian menit per waktu

Sama seperti `tune()` di situs. `{ fajr: 1, sunrise: -2, asr: 2, maghrib: 2, isha: 1 }`.

### `ihtiyati` dan `koreksi`

| Kunci | Arti | Bawaan |
|---|---|---|
| `ihtiyati` | pengaman dalam **detik**, dikurangi dari semua waktu | `0` |
| `koreksi` | koreksi manual per sholat dalam **menit**, mis. `{ "asr": 2 }` | `{}` |

Bawaan `0` supaya identik dengan situs. Naikkan `ihtiyati` ke `60` kalau mau
selalu lebih cepat 1 menit.

### `alerts`

| Kunci | Arti | Bawaan |
|---|---|---|
| `leadMinutes` | menit sebelum sholat untuk memicu. `15` = info, `5` = serius, `0` = sekarang | `[15, 5, 0]` |
| `prayers` | sholat mana yang diawasi | `["fajr","dhuhr","asr","maghrib","isha"]` |
| `lateToleranceMinutes` | alert yang telat lebih dari ini dianggap terlewat | `20` |
| `perPrayer` | override per sholat | `{}` |

Contoh `perPrayer` — Isya hanya info, tanpa notifikasi desktop:

```jsonc
"perPrayer": { "isha": { "leadMinutes": [5, 0], "desktop": false } }
```

### `channels`

**`desktop`**

| Kunci | Arti | Bawaan |
|---|---|---|
| `enabled` | nyala/mati | `true` |
| `criticalAtMinutes` | ≤ menit ini jadi `critical` (tidak hilang sendiri) | `5` |
| `timeoutMs` | durasi untuk yang non-critical | `15000` |
| `sound` | bunyi sistem notifikasi | `false` |
| `appName` | nama aplikasi di notifikasi | `"Waktu Sholat"` |
| `icon` | ikon notifikasi | `"org.gnome.clocks"` |

**`opencode`**

| Kunci | Arti | Bawaan |
|---|---|---|
| `enabled` | nyala/mati | `true` |
| `atLeadMinutes` | hanya lead ini yang dikirim ke TUI | `[5, 0]` |
| `targetFocusedPane` | tulis pane fokus, jadi hanya TUI yang dilihat yang toast | `true` |

**`luvusBar`** — `{ "enabled": true }`.

**`sound`**

| Kunci | Arti | Bawaan |
|---|---|---|
| `enabled` | nyala/mati | `false` |
| `url` | sumber adhan | adhan dari server landak |
| `file` | lokasi cache | `~/.local/state/sholat-monitor/adhan-makkah.mp3` |
| `player` | `auto` \| `ffplay` \| `paplay` \| `mpv` \| `cvlc` | `"auto"` |
| `volume` | 0–100 | `40` |
| `atLeadMinutes` | kapan diputar | `[0]` |

### `quiet` — jam tenang

Alert yang jatuh di rentang ini **dilewati** (tetap dicatat di log sebagai
`jam-tenang`). Rentang boleh melewati tengah malam.

```jsonc
"quiet": { "enabled": false, "from": "22:30", "to": "04:00" }
```

### `daemon`

| Kunci | Arti | Bawaan |
|---|---|---|
| `tickSeconds` | selang antar-perhitungan (minimal 5) | `60` |
| `syncDays` | seberapa sering membandingkan engine dengan landak | `1` |
| `syncAt` | jam `"HH:MM"` untuk sinkronisasi harian | `"03:20"` |

---

## Berkas dan state

```
bin/sholat                     CLI + entry point daemon
config.json                    semua setelan
src/daemon.js                  loop tick, plan(), deliver(), state
src/config.js                  pemuat JSONC + default + validasi
src/prayer-times.js            hitung jadwal (memuat vendor/PrayTimes.js)
src/sync.js                    bandingkan engine dengan server landak
src/focus.js                   tanya Luvus: pane mana yang sedang fokus
src/channels/                  desktop | opencode | luvus-bar | sound
vendor/PrayTimes.js            engine asli dari landak (di-vendor)
luvus-bar/                     module Luvus `sholat.bar`
opencode-tui/tui.js            sumber plugin TUI OpenCode
systemd/sholat-monitor.service unit systemd
test/                          20 tes unit + uji integrasi
```

State (bukan bagian repo):

```
~/.local/state/sholat-monitor/
  daemon-state.json   alert yang sudah dipicu, jumlah tick
  snapshot.json       jadwal hari ini + sholat berikutnya (untuk tool lain)
  daemon.log          log daemon, diputar sendiri di 2 MB
  alert.json          alert terakhir untuk plugin TUI
  plugin.log          jejak plugin TUI (bukti plugin benar-benar dimuat)
```

---

## Uji

```sh
node --test test/*.test.mjs      # 20 tes unit, tanpa jaringan, tanpa layar
node test/integration.mjs        # uji integrasi dengan channel dipalsukan
```

Keduanya memakai `SHOLAT_STATE_DIR` ke direktori sementara, jadi tidak
menyentuh state daemon yang sedang sungguhan berjalan.

---

## Kalau ada yang tidak beres

**Alert tidak muncul padahal service `active`.**

Periksa log dan state:

```sh
systemctl --user status sholat-monitor
journalctl --user -u sholat-monitor -n 50
tail -20 ~/.local/state/sholat-monitor/daemon.log
sholat status
```

**Daemon `active` tapi tidak ada file di state.** Ini pernah terjadi, dan
penyebabnya hampir selalu satu dari dua:

1. `ReadWritePaths` di unit **tidak sama persis** dengan `STATE_DIR` di
   `src/daemon.js`. Path harus cocok huruf per huruf.
2. Direktori state terhapus dan belum dibuat ulang.

Sejak diperbaiki, daemon **melaporkan sendiri** kalau tidak bisa menulis:
cari baris `PERINGATAN: tidak bisa menulis ke ...` di journal. Kalau tidak ada
peringatan itu, tulisannya baik-baik saja.

**Service gagal start dengan `status=218/CAPABILITIES`.** Di user service,
systemd tidak punya izin menurunkan capability untuk proses yang di-spawn, jadi
`NoNewPrivileges` dan `ProtectKernelModules` membuat unit tidak bisa jalan sama
sekali. Keduanya sengaja tidak dipakai; pengetatan filesystem
(`ProtectSystem=strict` + `ProtectHome=read-only` + `ReadWritePaths`) tetap
dipakai.

**Widget bar hilang dari bar.** Pastikan module-nya masih ter-link:

```sh
luvus module list | grep sholat.bar
node luvus-bar/publish.js     # coba push manual
```

**Tidak yakin plugin TUI jalan?** Lihat `~/.local/state/sholat-monitor/plugin.log`.
Ada baris `loaded` setiap kali plugin dimuat, dan `alert` setiap kali toast
muncul. Tanpa jejak ini, "tidak ada notifikasi" tidak bisa dibedakan dari
"plugin tidak dimuat".
