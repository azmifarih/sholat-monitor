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

`install` melakukan tiga hal:

1. Menyalin unit ke `~/.config/systemd/user/`, lalu `enable --now`.
2. Mengaktifkan **linger** supaya daemon tetap jalan setelah logout — bukan
   hanya selama sesi login.
3. Memasang **plugin TUI OpenCode** (salin berkas + daftarkan di `cli.json`).

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
| `luvusNotification` | `luvus ui toast` + `notification push` — toast & notification center Luvus | **aktif** |
| `sound` | memutar adhan dari server landak | **nonaktif** |

**Kenapa desktop yang utama.** Toast di dalam TUI hanya kelihatan kalau TUI
sedang aktif. Notifikasi desktop muncul di atas semua window, dan saat mendekati
waktu sholat (≤ `criticalAtMinutes`) dikirim sebagai `urgency=critical` sehingga
**tidak hilang sendiri**. Pengingat lead negatif ("sudah lewat 5/10 menit")
ikut aturan yang sama (`-5 ≤ 5`): telat justru berarti harus **lebih** menempel,
bukan lebih cepat hilang.

**Kenapa suara nonaktif secara bawaan.** Suara adalah satu-satunya channel yang
benar-benar merebut perhatian. Itu bagus saat kamu di meja, buruk kalau jam 4
pagi. Nyalakan kalau memang mau (`channels.sound.enabled`), atau pakai
`quiet` untuk membungkam jam-jam tertentu.

### Prasyarat lingkungan Luvus (mudah terlewat)

Channel `luvusBar`, `luvusNotification`, dan routing pane semuanya memanggil CLI
`luvus`. Service `systemd --user` **tidak** mewarisi PATH shell login, jadi unit
harus menyetel PATH sendiri:

```ini
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
```

Tanpa baris itu, channel Luvus gagal karena `luvus` tidak ketemu — dulu
dilaporkan sebagai `exit null`, yang terbaca seperti "ditolak" padahal
prosesnya **tidak pernah jalan**. Channel `desktop` tetap `ok` karena
`notify-send` ada di `/usr/bin`, jadi gejalanya menyesatkan: "alert desktop
muncul, toast dan bar Luvus tidak".

#### Sesi Luvus: dicari, bukan dikunci

`luvus` tanpa `LUVUS_SESSION` menargetkan sesi `default`, dan sesi itu biasanya
`stopped` — jadi perintahnya jalan tapi tidak sampai ke UI yang sedang dipakai.
Karena itu `LUVUS_SESSION` boleh disetel di unit:

```ini
Environment=LUVUS_SESSION=probe
```

Tapi baris itu **hanya preferensi, bukan pengunci**. Daemon memeriksa dulu bahwa
sesi itu benar-benar running:

| Keadaan | Yang dipakai | `source` |
|---|---|---|
| `LUVUS_SESSION` diset dan sesinya running | sesi itu | `env` |
| `LUVUS_SESSION` diset tapi sesinya sudah tidak ada | sesi running yang ditemukan sendiri | `env-usang` |
| `LUVUS_SESSION` kosong | sesi running yang ditemukan sendiri | `ditemukan` |
| `LUVUS_SESSION=auto` | selalu sesi running (env diabaikan) | `ditemukan` |
| tidak ada sesi running | biarkan gagal, jangan menebak | `tanpa-sesi` |
| `luvus session list` tidak terbaca | `LUVUS_SESSION` dipakai apa adanya | `tidak-terbaca` |

Jadi sesi boleh berganti nama kapan saja: daemon pindah sendiri, dan mencatatnya
di log. `sholat doctor` menampilkan sesi yang akhirnya dipakai beserta asalnya:

```
ok    sesi luvus                 probe (env; hidup: probe)
```

Sesi yang ditarget juga bisa dibaca langsung dari environment daemon:

```sh
PID=$(systemctl --user show sholat-monitor -p MainPID --value)
tr '\0' '\n' < /proc/$PID/environ | grep -E '^(PATH|LUVUS_SESSION)='
```

### Routing ke TUI OpenCode

Daemon tidak tahu terminal mana yang sedang kamu lihat. Luvus tahu. Jadi:

1. Daemon bertanya `luvus pane list` → dapat pane yang sedang fokus.
2. Pane itu ditulis ke `alert.json`.
3. Plugin TUI membandingkannya dengan `LUVUS_PANE_ID` miliknya sendiri.

Hasilnya: **hanya TUI yang sedang kamu lihat yang menampilkan toast**, bukan
semua TUI yang terbuka. Kalau Luvus tidak bisa dihubungi, alert tetap ditulis
tanpa target dan semua TUI menampilkannya (lebih baik berisik daripada tidak
sampai).

### Memasang plugin TUI

`sholat install` sudah menangani ini: berkasnya disalin ke
`~/.config/opencode/sholat-alert/`, lalu `./sholat-alert` didaftarkan di
`~/.config/opencode/cli.json` pada key **`plugins`** (plural).

Aman dijalankan berulang: entri yang sudah ada tidak ditambahkan dua kali,
`cli.json` dicadangkan sebelum diubah, dan kalau file itu tidak bisa dibaca
sebagai JSON, **tidak ditimpa** — cukup diberi tahu cara mendaftarkan manual.
Plugin baru dimuat setelah OpenCode dijalankan ulang.

Kalau mau manual, sumbernya di `opencode-tui/` (`package.json` + `tui.js`):

```sh
mkdir -p ~/.config/opencode/sholat-alert
cp opencode-tui/package.json opencode-tui/tui.js ~/.config/opencode/sholat-alert/
```

```jsonc
// ~/.config/opencode/cli.json
{
  "plugins": ["./sholat-alert"]
}
```

Catatan yang sempat menelan waktu: konfigurasi plugin TUI dibaca dari
`cli.json`, **bukan** `tui.json` atau `tui.jsonc` — file itu diabaikan binary-nya.


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
| `leadMinutes` | menit relatif ke sholat. Positif = sebelum (`15` info, `5` serius), `0` = tepat waktu, **negatif = pengingat sesudah** (`-5` = "sudah lewat 5 menit") | `[15, 5, 0, -5, -10]` |
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
| `atLeadMinutes` | hanya lead ini yang dikirim ke TUI | `[5, 0, -5, -10]` |
| `targetFocusedPane` | tulis pane fokus, jadi hanya TUI yang dilihat yang toast | `true` |

**`luvusBar`** — `{ "enabled": true }`.

**`luvusNotification`**

| Kunci | Arti | Bawaan |
|---|---|---|
| `enabled` | nyala/mati | `true` |
| `atLeadMinutes` | hanya lead ini yang dikirim ke Luvus | `[5, 0, -5, -10]` |

Toast berkedip satu baris di UI Luvus, notification masuk ke daftar yang bisa
dibaca ulang. Lead-nya dibatasi sama seperti toast TUI karena keduanya permukaan
berisik yang sama; notifikasi desktop tetap menerima semua lead tanpa filter.

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
src/luvus.js                   satu pintu panggil CLI luvus: PATH + pilih sesi
src/focus.js                   tanya Luvus: pane mana yang sedang fokus
src/opencode-plugin.js         pasang + daftarkan plugin TUI di cli.json
src/channels/                  desktop | opencode | luvus-bar | luvus-notification | sound
vendor/PrayTimes.js            engine asli dari landak (di-vendor)
luvus-bar/                     module Luvus `sholat.bar`
opencode-tui/                   sumber plugin TUI OpenCode (package.json + tui.js)
systemd/sholat-monitor.service unit systemd
test/                          27 tes unit + uji integrasi
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
node --test test/*.test.mjs      # 50 tes unit, tanpa jaringan, tanpa layar
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

**Service gagal start dengan `status=218/CAPABILITIES`.** Setiap direktif yang
**menghapus capability** gagal di user service, karena itu butuh `CAP_SETPCAP`
yang tidak dimiliki user manager. Yang termasuk: `ProtectKernelModules`
(menghapus `CAP_SYS_MODULE`), `ProtectKernelLogs` (menghapus `CAP_SYSLOG`), dan
`CapabilityBoundingSet=...`. Ketiganya sengaja tidak dipakai.

`NoNewPrivileges` **tidak** menghapus capability, jadi aman dan tetap dipakai.
Begitu juga `ProtectSystem=strict`, `ProtectHome=read-only`, `ReadWritePaths`,
`ProtectKernelTunables`, `ProtectControlGroups`, `RestrictNamespaces`,
`RestrictRealtime`, `RestrictSUIDSGID`, dan `PrivateTmp`.

Aturan cepatnya: kalau sebuah direktif menyebut nama capability, jangan pakai di
user service.

**Channel `luvus` gagal dengan `exit null`, padahal channel `desktop` ok.**

Ini penyebab asli "Maghrib tidak pernah muncul di toast/notification Luvus".
`exit null` dari `spawnSync` berarti **prosesnya tidak pernah jalan** (ENOENT),
bukan prosesnya jalan lalu menolak. Sebabnya soal lingkungan service, bukan soal
jadwal:

1. **`~/.local/bin` tidak ada di PATH service.** `systemd --user` tidak mewarisi
   PATH shell login. `luvus` tinggal di `~/.local/bin/luvus`, jadi tidak ketemu.
   Channel `desktop` tetap `ok` karena `notify-send` ada di `/usr/bin`.
2. **Sesi Luvus tidak disebut.** CLI `luvus` lalu menargetkan sesi `default`,
   dan sesi itu biasanya `stopped`. Perintahnya jalan, tapi tidak sampai ke UI
   yang sedang dipakai.

Sejak `src/luvus.js` ada, sebab nomor 2 tidak lagi bisa mematikan channel:
kalau `LUVUS_SESSION` menunjuk sesi yang sudah tidak ada, daemon memilih sesi
running yang ada dan mencatatnya sebagai `env-usang`. Sebab nomor 1 masih nyata,
karena tidak ada yang bisa mencari binary yang tidak ada di PATH.

Periksa keduanya sekaligus:

```sh
sholat doctor                 # baris "sesi luvus" + "luvus server"
luvus session list            # cari baris berstatus "running"
rg '^Environment' ~/.config/systemd/user/sholat-monitor.service
```

Yang wajib ada di unit cuma PATH:

```ini
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
```

Sesudah mengubah unit: `systemctl --user daemon-reload && systemctl --user restart sholat-monitor`.

Cara memastikan perbaikan ini benar-benar berlaku untuk daemon (bukan cuma untuk
shell-mu): baca environment daemon yang sebenarnya.

```sh
PID=$(systemctl --user show sholat-monitor -p MainPID --value)
tr '\0' '\n' < /proc/$PID/environ | grep -E '^(PATH|LUVUS_SESSION)='
tail -5 ~/.local/state/sholat-monitor/daemon.log | grep 'sesi luvus'
```

Baris `sesi luvus: ... (env-usang; ...)` berarti daemon sedang menolong dirinya
sendiri. Kalau `PATH` sudah benar tapi channel tetap gagal, `failureReason()`
akan menyebut binary dan PATH-nya di `daemon.log` — tidak lagi `exit null`.

**Widget bar hilang dari bar.** Pastikan module-nya masih ter-link:

```sh
luvus module list | grep sholat.bar
node luvus-bar/publish.js     # coba push manual
```

Daemon mencatat hasil repaint bar **saat berubah saja**: satu baris `bar ok
(widget hidup lagi)` saat pulih, dan `bar GAGAL: ...` saat mulai gagal. Tidak ada
baris per menit - kalau ada, log justru membanjir dan menyembunyikan alert.
Kalau widget beku di sholat yang salah tapi tidak ada baris `bar GAGAL`,
berarti push-nya sukses dan masalahnya di sisi tampilan Luvus.

**Tidak yakin plugin TUI jalan?** Lihat `~/.local/state/sholat-monitor/plugin.log`.
Ada baris `loaded` setiap kali plugin dimuat, dan `alert` setiap kali toast
muncul. Tanpa jejak ini, "tidak ada notifikasi" tidak bisa dibedakan dari
"plugin tidak dimuat".
