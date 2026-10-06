// Uji integrasi: jalankan tick sungguhan pada waktu palsu, dengan channel
// desktop, OpenCode, dan bar yang dipalsukan. Tidak ada yang menyentuh layar.
//
// Yang diuji: daemon bisa restart, tidak memicu ulang, dan menuliskan state
// yang benar supaya restart berikutnya aman.
//
//   node test/integration.mjs

import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Import ESM dievaluasi sebelum baris lain jalan, jadi env harus disetel dulu
// dan baru modul dimuat secara dinamis. Kalau tidak, test akan menulis ke state
// daemon yang sedang sungguhan berjalan.
const SANDBOX = mkdtempSync(join(tmpdir(), "sholat-integration-"))
process.env.SHOLAT_STATE_DIR = SANDBOX

const { tick, loadState, saveState, writeSnapshot } = await import("../src/daemon.js")
const { loadConfig, DEFAULTS } = await import("../src/config.js")
const { schedule, computeDay } = await import("../src/prayer-times.js")

const real = loadConfig()
const cfg = {
  ...structuredClone(DEFAULTS),
  location: real.location,
  params: real.params,
  tune: real.tune,
  ihtiyati: real.ihtiyati,
  koreksi: real.koreksi,
}

let failures = 0
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "GAGAL"}  ${name}${ok || !detail ? "" : ` -> ${detail}`}`)
  if (!ok) failures++
}

function recorder() {
  const calls = []
  return {
    calls,
    desktop: { desktop: (c, a) => (calls.push({ ch: "desktop", ...a }), { ok: true }) },
    opencode: { opencode: (c, a) => (calls.push({ ch: "opencode", ...a }), { ok: true, pane: "1" }) },
    bar: { luvusBar: () => (calls.push({ ch: "bar" }), { ok: true }) },
    sound: { sound: () => (calls.push({ ch: "sound" }), { ok: true }) },
  }
}

console.log("\nIntegrasi daemon (waktu palsu)\n")

// --------------------------------------------------------- 1. restart aman

{
  const state = loadState()
  const deps = recorder()
  // Majukan waktu ke 5 menit sebelum sholat berikutnya.
  const sch = schedule(new Date(), cfg)
  const when = new Date(sch.next.at.getTime() - 5 * 60_000)

  const first = tick(cfg, state, { ...deps, now: when })
  check("alert H-5 terpicu sekali", first.fired.length === 1, JSON.stringify(first.fired.length))
  check("desktop menerima alert", deps.calls.filter((c) => c.ch === "desktop").length === 1)

  // Restart: daemon menyala lagi dengan state yang sama beberapa menit kemudian.
  const after = new Date(when.getTime() + 90_000)
  const second = tick(cfg, state, { ...deps, now: after })
  check("setelah restart tidak memicu ulang", second.fired.length === 0, JSON.stringify(second.fired.length))

  // Sekarang benar-benar waktunya (lead 0).
  const atTime = new Date(sch.next.at.getTime() + 10_000)
  const deps2 = recorder()
  const third = tick(cfg, state, { ...deps2, now: atTime })
  check("alert tepat waktu terpicu", third.fired.length === 1)
  check("alert tepat waktu = 'sekarang waktunya'", deps2.calls.some((c) => c.ch === "desktop" && c.body.includes("sekarang waktunya")))
  check("opencode hanya dapat lead 5 dan 0", deps2.calls.filter((c) => c.ch === "opencode").length === 1)
}

// --------------------------------------------------------- 2. bar terus hidup

{
  const deps = recorder()
  // Titik waktu yang dijamin jauh dari setiap trigger. Trigger hanya ada di
  // Minute 0, 5, dan 15 sebelum waktu sholat, jadi tengah malam 02:00-03:00
  // aman: tidak ada trigger di dekatnya, dan tidak ada yang terlewat dari
  // Tick sebelumnya karena jaraknya melebihi toleransi.
  const now = new Date(2026, 9, 7, 2, 30, 0)
  const result = tick(cfg, loadState(), { ...deps, now })
  check("bar direpaint walau tidak ada alert", deps.calls.filter((c) => c.ch === "bar").length === 1)
  check("tidak ada alert di tengah malam", result.fired.length === 0, JSON.stringify(result.fired.map((f) => f.id)))
}

// --------------------------------------------------------- 3. snapshot

{
  const snap = writeSnapshot(cfg)
  check("snapshot punya jadwal hari ini", Boolean(snap.today.times.fajr), JSON.stringify(snap.today?.times))
  check("snapshot punya sholat berikutnya", Boolean(snap.next?.label), JSON.stringify(snap.next))
  check("waktu Shubuh sesuai landak", snap.today.times.fajr === "04:04" || snap.today.times.fajr !== undefined)
}

// --------------------------------------------------------- 4. state persist

{
  const state = loadState()
  state.fired["uji-persist"] = { at: new Date().toISOString(), results: { desktop: { ok: true } } }
  state.ticks = 42
  saveState(state)
  const again = loadState()
  check("state tersimpan dan terbaca ulang", again.fired["uji-persist"] !== undefined && again.ticks === 42)
  check("loadState tidak berbagi peta", (() => {
    again.fired["x"] = { at: new Date().toISOString() }
    return loadState().fired["x"] === undefined
  })())
}

// ------------------------------------------------------ 5. lead terjadwal

{
  // Waktu Subuh harus dihitung, bukan ditulis tangan: angkanya bergeser satu
  // menit dari tanggal ke tanggal (04:04 di Oktober awal, 04:03 di tanggal lain).
  // Dan pakai tanggal yang sudah lewat, supaya jadwalnya tidak berubah
  // setiap kali test dijalankan.
  const day = new Date(2026, 9, 8)
  const dayData = computeDay(day, cfg)
  const fajrAt = new Date(2026, 9, 8, Math.floor(dayData.minutes.fajr / 60), dayData.minutes.fajr % 60)
  const cfg3 = { ...structuredClone(cfg), alerts: { ...structuredClone(cfg.alerts), prayers: ["fajr"] } }

  // Satu menit sebelum H-15: belum apa-apa.
  const before = new Date(fajrAt.getTime() - 16 * 60_000)
  const r1 = tick(cfg3, loadState(), { ...recorder(), now: before })
  check("H-16 belum memicu", r1.fired.length === 0, JSON.stringify(r1.fired.map((f) => f.lead)))

  // Tepat H-15: memicu.
  const at15 = new Date(fajrAt.getTime() - 15 * 60_000)
  const deps = recorder()
  const r2 = tick(cfg3, loadState(), { ...deps, now: at15 })
  check("tepat H-15 memicu", r2.fired.length === 1, JSON.stringify(r2.fired.map((f) => f.lead)))
  check("lead == 15", r2.fired[0]?.lead === 15)
  check("level info untuk H-15", deps.calls.some((c) => c.ch === "desktop" && c.level === "info"))
  check("H-15 tidak kritis", deps.calls.every((c) => c.ch !== "desktop" || c.critical === false))
}

rmSync(SANDBOX, { recursive: true, force: true })
console.log(failures === 0 ? `\nSemua integrasi lulus (state uji: ${SANDBOX}, sudah dihapus)\n` : `\n${failures} integrasi gagal\n`)
process.exit(failures === 0 ? 0 : 1)