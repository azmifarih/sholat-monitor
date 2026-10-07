#!/usr/bin/env node
// publish.js -- repaint widget "Waktu Shalat" di Luvus Bar.
//
// Dipanggil daemon tiap menit, dan sekali dari hook [[startup]] saat session siap.
// Sekali push = konten widget diganti seluruhnya, bukan ditambahkan.
//
//   node publish.js          -> hitung lalu push ke Luvus Bar
//   node publish.js --json   -> cetak payload JSON saja (untuk debug)

import { loadConfig } from "../src/config.js"
import { schedule, fmtCountdown } from "../src/prayer-times.js"
import { runLuvus, failureReason } from "../src/luvus.js"

// loadConfig, bukan JSON.parse: config.json boleh dikomentari, dan semua
// pembacaan config harus lewat satu pintu agar tidak ada yang gagal diam-diam.
const cfg = loadConfig()

// Widget ini milik module, jadi cukup pakai id lokal: "next".
const BAR_ID = "next"

const s = schedule(new Date(), cfg)

if (!s.next) {
  console.error("tidak ada sholat berikutnya yang dihitung")
  process.exit(1)
}

const soon = s.next.minutesLeft <= 15
const cdTone = s.next.minutesLeft <= 5 ? "error" : soon ? "warning" : "success"
const cdText = s.next.tomorrow ? `besok ${fmtCountdown(s.next.minutesLeft)}` : fmtCountdown(s.next.minutesLeft)

// Bentuk penuh: dipakai saat ruang di bar masih lega.
// Waktu dan countdown jadi dua chip terpisah, bukan satu baris yang nempel.
const content = [
  { type: "text", text: "WAKTU SHOLAT", tone: "muted" },
  { type: "spacer", width: 2 },
  { type: "badge", text: `${s.next.label} ${s.next.time}`, tone: "accent", action: "today", value: s.next.date },
  { type: "spacer", width: 2 },
  { type: "badge", text: cdText, tone: cdTone },
]

// Bentuk ringkas: kalau bar sempit, yang dijaga adalah waktu + countdown-nya.
const compact = [
  { type: "badge", text: `${s.next.label} ${s.next.time}`, tone: "accent", action: "today", value: s.next.date },
  { type: "spacer", width: 1 },
  { type: "badge", text: fmtCountdown(s.next.minutesLeft), tone: cdTone },
]

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ content, compact, next: s.next }, null, 2))
  process.exit(0)
}

// runLuvus: sesi dan binary Luvus diselesaikan di src/luvus.js. Penting di sini
// karena skrip ini dipanggil dari dua arah - daemon, dan hook [[startup]] milik
// Luvus sendiri. Kalau environment dari Luvus tidak menyetel LUVUS_SESSION,
// skrip ini tetap menemukan sesi yang hidup.
const res = runLuvus(
  ["bar", "push", "--id", BAR_ID, "--content", JSON.stringify(content), "--compact-content", JSON.stringify(compact)],
  { timeout: 10_000 },
)

if (res.status !== 0) {
  // Modul tidak boleh menjatuhkan UI; cukup catat, `luvus module log` yang baca.
  console.error(failureReason(res))
  process.exit(res.status ?? 1)
}