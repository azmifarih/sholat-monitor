#!/usr/bin/env node
// today.js -- aksi saat widget diklik: tampilkan jadwal hari ini sebagai toast.

import { spawnSync } from "node:child_process"
import { loadConfig } from "../src/config.js"
import { schedule, PRAYERS } from "../src/prayer-times.js"

const cfg = loadConfig()
const luvus = process.env.LUVUS_BIN_PATH ?? "luvus"

const s = schedule(new Date(), cfg)
const rows = PRAYERS.filter((p) => ["fajr", "dhuhr", "asr", "maghrib", "isha"].includes(p.key))
  .map((p) => `${p.label} ${s.today.times[p.key]}`)
  .join("  ·  ")

spawnSync(luvus, ["ui", "toast", `${s.today.kota}, ${s.today.date} — ${rows}`], { encoding: "utf8" })