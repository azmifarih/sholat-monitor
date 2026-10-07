#!/usr/bin/env node
// today.js -- aksi saat widget diklik: tampilkan jadwal hari ini sebagai toast.

import { loadConfig } from "../src/config.js"
import { schedule, PRAYERS } from "../src/prayer-times.js"
import { runLuvus } from "../src/luvus.js"

const cfg = loadConfig()

const s = schedule(new Date(), cfg)
const rows = PRAYERS.filter((p) => ["fajr", "dhuhr", "asr", "maghrib", "isha"].includes(p.key))
  .map((p) => `${p.label} ${s.today.times[p.key]}`)
  .join("  ·  ")

// Ini aksi klik widget, jadi dijalankan oleh Luvus - bukan oleh daemon. Karena
// itu sesi TIDAK boleh diasumsikan dari environment daemon; runLuvus yang
// mencarinya.
runLuvus(["ui", "toast", `${s.today.kota}, ${s.today.date} — ${rows}`])