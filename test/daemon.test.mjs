// Tes logika daemon: penjadwalan waktu, dedup, toleransi telat, jam tenang,
// dan override per sholat. Tidak butuh jaringan dan tidak menyentuh desktop.
//
//   node --test test/

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Tes TIDAK boleh menulis ke state/log daemon yang sedang sungguhan berjalan.
// `log()` di daemon.js menulis ke file log, dan tick() memanggilnya untuk setiap
// alert - jadi tanpa isolasi, tiap kali tes dijalankan log produksi terisi
// alert palsu yang terlihat seperti kejadian sungguhan.
//
// Import ESM dievaluasi sebelum baris lain jalan, jadi env harus disetel dulu
// dan modul dimuat secara dinamis (sama seperti test/integration.mjs).
const SANDBOX = mkdtempSync(join(tmpdir(), "sholat-test-"))
process.env.SHOLAT_STATE_DIR = SANDBOX

const { loadConfig, stripJsonComments, DEFAULTS, forPrayer, inQuietHours } = await import("../src/config.js")
const { plan, tick, alertText } = await import("../src/daemon.js")
const { computeDay, schedule, ymd } = await import("../src/prayer-times.js")

process.on("exit", () => rmSync(SANDBOX, { recursive: true, force: true }))

// ------------------------------------------------------------- JSONC parser

test("stripJsonComments membuang komentar tapi bukan tanda kutip", () => {
  const input = `{
    // komentar baris
    "a": 1, /* blok */ "b": "http://x//y", "c": "/* bukan */"
  }`
  assert.deepEqual(JSON.parse(stripJsonComments(input)), { a: 1, b: "http://x//y", c: "/* bukan */" })
})

// ------------------------------------------------------------- perhitungan

test("jadwal Semarang memakai angka landak", () => {
  const day = computeDay(new Date(2026, 9, 6), {})
  assert.equal(day.times.fajr, "04:04")
  assert.equal(day.times.dhuhr, "11:29")
  assert.equal(day.times.asr, "14:33")
  assert.equal(day.times.maghrib, "17:35")
  assert.equal(day.times.isha, "18:43")
})

test("ihtiyati mengurangi waktu, koreksi menambah", () => {
  const base = computeDay(new Date(2026, 9, 6), {})
  const ihtiyati = computeDay(new Date(2026, 9, 6), { ihtiyati: 60 })
  assert.equal(ihtiyati.times.dhuhr, "11:28", "60 detik pengaman = 1 menit lebih awal")

  const koreksi = computeDay(new Date(2026, 9, 6), { koreksi: { asr: 3 } })
  assert.equal(koreksi.times.asr, "14:36")
  assert.equal(koreksi.times.dhuhr, base.times.dhuhr, "koreksi satu sholat tidak boleh mengubah sholat lain")
})

test("schedule mencari sholat berikutnya lintas hari", () => {
  // 20:00 WIB: semua sholat hari ini sudah lewat, jadi berikutnya Shubuh besok.
  const now = new Date(2026, 9, 6, 20, 0, 0)
  const s = schedule(now, { now })
  assert.equal(s.next.key, "fajr")
  assert.equal(s.next.tomorrow, true)
  assert.equal(s.next.time, "04:04")
  assert.ok(s.next.minutesLeft > 400 && s.next.minutesLeft < 500)
})

// ---------------------------------------------------------------- planning

function cfgWith(overrides = {}) {
  return { ...structuredClone(DEFAULTS), ...structuredClone(overrides) }
}

test("plan menghasilkan satu event per lead, terurut dari yang terdekat", () => {
  const cfg = cfgWith({ alerts: { ...DEFAULTS.alerts, leadMinutes: [15, 5, 0], prayers: ["fajr"] } })
  const now = new Date(2026, 9, 6, 3, 0, 0) // 03:00, Shubuh 04:04
  const events = plan(cfg, now)
  assert.equal(events.length, 3)
  // Terurut berdasarkan waktu picu, bukan berdasarkan besar lead.
  assert.deepEqual(events.map((e) => e.lead), [15, 5, 0])
  assert.deepEqual(
    events.map((e) => e.id),
    ["2026-10-06-fajr@15", "2026-10-06-fajr@5", "2026-10-06-fajr@0"],
  )
  assert.ok(events.every((e) => e.clock === "04:04"))
  // Jendela rencana 24 jam dari 03:00 berakhir 03:00 besok, jadi Shubuh besok
  // (04:04) belum masuk dan tidak boleh muncul di sini.
  assert.equal(plan(cfg, now).filter((e) => ymd(e.prayerAt) === "2026-10-07").length, 0)
})

test("plan tidak menghasilkan event yang sudah lewat", () => {
  const cfg = cfgWith({ alerts: { ...DEFAULTS.alerts, leadMinutes: [15, 5, 0], prayers: ["isha"] } })
  const now = new Date(2026, 9, 6, 19, 30, 0) // Isya 18:43 sudah lewat
  const events = plan(cfg, now)
  assert.ok(events.every((e) => e.when >= now))
  assert.ok(events.every((e) => e.prayerKey === "isha"))
  assert.ok(events.every((e) => e.clock === "18:43"))
})

// ------------------------------------------------------------------- alert

test("alertText menyebut sisa menit dan kritikalitas", () => {
  const cfg = cfgWith()
  const at = new Date(2026, 9, 6, 11, 29, 0)
  const make = (lead) => ({ lead, label: "Dzuhur", clock: "11:29", prayerAt: at, id: `x@${lead}` })

  const far = alertText(cfg, make(15))
  assert.match(far.body, /15 menit lagi/)
  assert.equal(far.level, "info")
  assert.equal(far.critical, false)

  const near = alertText(cfg, make(5))
  assert.match(near.body, /5 menit lagi/)
  assert.equal(near.level, "warning")
  assert.equal(near.critical, true)

  const now = alertText(cfg, make(0))
  assert.match(now.body, /sekarang waktunya/)
  assert.equal(now.durationMs, 30_000)
})

test("alertText untuk lead negatif menyebut 'sudah lewat'", () => {
  const cfg = cfgWith()
  const at = new Date(2026, 9, 6, 11, 29, 0)
  const late = alertText(cfg, { lead: -5, label: "Dzuhur", clock: "11:29", prayerAt: at, id: "x@-5" })
  assert.match(late.body, /sudah lewat 5 menit/)
  assert.doesNotMatch(late.body, /menit lagi/, "lead negatif tidak boleh terbaca sebagai sisa waktu")
  assert.equal(late.level, "warning")
  // Pengingat telat harus menempel (critical), bukan hilang sendiri - itu
  // gunanya: mengejar orang yang terlewat H-0 tadi.
  assert.equal(late.critical, true)
  assert.equal(late.minutesLeft, -5)
})

// ---------------------------------------------------- pengingat sesudahnya

test("plan memasukkan pengingat sesudah waktu sholat", () => {
  const cfg = cfgWith({ alerts: { ...DEFAULTS.alerts, leadMinutes: [0, -5, -10], prayers: ["fajr"] } })
  const now = new Date(2026, 9, 6, 3, 0, 0) // Shubuh 04:04
  const events = plan(cfg, now)
  // Urutan ikut waktu picu: -5 dan -10 jatuh SESUDAH H-0.
  assert.deepEqual(events.map((e) => e.lead), [0, -5, -10])
  const minus10 = events.find((e) => e.lead === -10)
  assert.equal(minus10.when.getTime(), new Date(2026, 9, 6, 4, 14, 0).getTime(), "04:04 + 10 menit")
  assert.ok(minus10.id.endsWith("@-10"), "id harus beda dari lead positif supaya tidak saling menimpa")
})

test("tick memicu pengingat sesudah waktunya, paling baru yang didengar", () => {
  const cfg = cfgWith({ alerts: { ...DEFAULTS.alerts, leadMinutes: [0, -5], prayers: ["dhuhr"] } })
  // Dzuhur 11:29; sekarang 11:34 = sudah lewat 5 menit. H-0 (11:29) memang
  // jatuh tempo juga, tapi situasinya sudah "telat 5 menit" - yang itu yang
  // relevan, bukan "sekarang waktunya" yang sudah basi.
  const state = blankState()
  const deps = recorder()
  const result = tick(cfg, state, { ...deps, now: new Date(2026, 9, 6, 11, 34, 0) })

  assert.deepEqual(result.fired.map((f) => f.lead), [-5], "hanya pengingat terbaru yang berbunyi")
  assert.ok(
    deps.calls.some(([name, body]) => name === "desktop" && /sudah lewat 5 menit/.test(body)),
    "desktop harus menerima teks 'sudah lewat'",
  )
  // Tick berikutnya pada waktu yang sama tidak mengulang.
  assert.equal(tick(cfg, state, { ...deps, now: new Date(2026, 9, 6, 11, 34, 0) }).fired.length, 0)
})

// -------------------------------------------------------------------- tick

// Test tidak boleh membaca state daemon yang sedang sungguhan jalan - kalau
// iya, `fired` sudah terisi dan assertion "terpicu" gagal sendiri.
function blankState() {
  return { fired: {}, ticks: 0, startedAt: null, lastTickAt: null, lastSyncAt: null }
}

// Channel palsu: mencatat panggilan tanpa menyentuh desktop atau Luvus.
function recorder() {
  const calls = []
  return {
    calls,
    desktop: { desktop: (c, a) => (calls.push(["desktop", a.body]), { ok: true }) },
    opencode: { opencode: (c, a) => (calls.push(["opencode", a.body]), { ok: true, pane: "1" }) },
    bar: { luvusBar: () => (calls.push(["bar"]), { ok: true }) },
    sound: { sound: () => (calls.push(["sound"]), { ok: true }) },
  }
}

test("tick memicu alert dan tidak memicu dua kali", () => {
  const cfg = cfgWith({ alerts: { ...DEFAULTS.alerts, leadMinutes: [5], prayers: ["fajr"] } })
  const now = new Date(2026, 9, 6, 3, 59, 30) // 1.5 menit sebelum Shubuh
  const state = blankState()
  const deps = recorder()

  const first = tick(cfg, state, { ...deps, now })
  assert.equal(first.fired.length, 1, "alert harus kepicu sekali")
  assert.ok(deps.calls.some(([name]) => name === "desktop"))

  // Tick kedua pada waktu yang sama tidak boleh mengulang.
  const second = tick(cfg, state, { ...deps, now })
  assert.equal(second.fired.length, 0, "sama id tidak boleh memicu ulang")
})

test("alert yang telat lebih dari toleransi tidak masuk daftar sama sekali", () => {
  const cfg = cfgWith({
    alerts: { ...DEFAULTS.alerts, leadMinutes: [15], prayers: ["fajr"], lateToleranceMinutes: 20 },
  })
  // Shubuh 04:04, lead 15 -> picu 03:49. Daemon bangun 04:30 = 41 menit telat,
  // lewat dari toleransi 20 menit, jadi tidak boleh dipicu.
  const state = blankState()
  const deps = recorder()
  tick(cfg, state, { ...deps, now: new Date(2026, 9, 6, 4, 30, 0) })

  assert.equal(state.fired["2026-10-06-fajr@15"], undefined, "sudah terlewat, tidak dicatat")
  assert.ok(
    !deps.calls.some(([name, body]) => name === "desktop" && body?.includes("04:04")),
    "alert yang telat tidak boleh sampai ke desktop",
  )
})

test("alert telat tapi masih dalam toleransi tetap dipicu", () => {
  // Ini yang membuat daemon boleh restart: kalau dia hidup lagi 7 menit setelah
  // H-15 lewat (tapi masih di dalam toleransi), alert itu tetap perlu berbunyi.
  const cfg = cfgWith({
    alerts: { ...DEFAULTS.alerts, leadMinutes: [15], prayers: ["fajr"], lateToleranceMinutes: 20 },
  })
  const state = blankState()
  const deps = recorder()
  // Picu 03:49; sekarang 03:56 = 7 menit telat.
  tick(cfg, state, { ...deps, now: new Date(2026, 9, 6, 3, 56, 0) })
  assert.ok(
    deps.calls.some(([name, body]) => name === "desktop" && body?.includes("15 menit lagi")),
    "alert yang telat sedikit tetap harus berbunyi",
  )
})

test("jam tenang menandai alert sebagai dilewati", () => {
  const cfg = cfgWith({
    alerts: { ...DEFAULTS.alerts, leadMinutes: [5], prayers: ["fajr"] },
    quiet: { enabled: true, from: "03:00", to: "05:00" },
  })
  const state = blankState()
  const deps = recorder()
  tick(cfg, state, { ...deps, now: new Date(2026, 9, 6, 3, 59, 30) })

  assert.equal(state.fired["2026-10-06-fajr@5"]?.skipped, "jam-tenang")
  // Shubuh besok (03:58) masih di masa depan, jadi belum disentuh sama sekali -
  // Penilaian jam tenang cuma terjadi saat waktunya benar-benar tiba.
  assert.equal(state.fired["2026-10-07-fajr@5"], undefined)
  assert.equal(deps.calls.filter(([n]) => n === "desktop").length, 0, "tidak boleh ada bunyi di jam tenang")
  assert.ok(deps.calls.some(([n]) => n === "bar"), "bar tetap direpaint")
})

test("di luar jam tenang, alert tetap dikirim", () => {
  // Jam tenang yang tidak menutup Subuh pagi.
  const cfg = cfgWith({
    alerts: { ...DEFAULTS.alerts, leadMinutes: [5], prayers: ["fajr"] },
    quiet: { enabled: true, from: "22:00", to: "02:00" },
  })
  const state = blankState()
  const deps = recorder()
  tick(cfg, state, { ...deps, now: new Date(2026, 9, 6, 3, 59, 30) })

  assert.equal(state.fired["2026-10-06-fajr@5"]?.skipped, undefined)
  assert.ok(
    deps.calls.some(([name, body]) => name === "desktop" && body?.includes("5 menit lagi")),
    "alert di luar jam tenang harus tetap berbunyi",
  )
})

test("perPrayer bisa mematikan channel per sholat", () => {
  const cfg = cfgWith({
    alerts: {
      ...DEFAULTS.alerts,
      leadMinutes: [0],
      prayers: ["isha"],
      perPrayer: { isha: { desktop: false } },
    },
  })
  // Isya 18:43, lead 0. Horizon 24 jam jadi Isya besok juga ikut terencana,
  // dan override-nya berlaku untuk keduanya.
  const state = blankState()
  const deps = recorder()
  tick(cfg, state, { ...deps, now: new Date(2026, 9, 6, 18, 43, 0) })

  assert.equal(deps.calls.filter(([n]) => n === "desktop").length, 0, "desktop harus mati untuk Isya")
  assert.ok(deps.calls.some(([n]) => n === "opencode"), "channel lain tetap jalan")
})

test("bar widget selalu direpaint walau tidak ada alert", () => {
  // 12:00, lead 15 untuk fajr: picu hari ini sudah lewat (>20 menit), jadi
  // tidak ada yang jatuh tempo - tapi bar tetap harus dicat ulang.
  const cfg = cfgWith({ alerts: { ...DEFAULTS.alerts, leadMinutes: [15], prayers: ["fajr"] } })
  const deps = recorder()
  const result = tick(cfg, blankState(), { ...deps, now: new Date(2026, 9, 6, 12, 0, 0) })
  assert.ok(deps.calls.some(([n]) => n === "bar"), "bar harus dipaint setiap tick")
  assert.equal(result.fired.length, 0, "tidak ada yang jatuh tempo")
})

test("event di masa depan tidak memicu pada tick pertama", () => {
  // Regresi: tanpa penjaga `event.when > now`, semua event dalam horizon 24 jam
  // akan memicu sekaligus saat daemon baru start.
  const cfg = cfgWith()
  const deps = recorder()
  const result = tick(cfg, blankState(), { ...deps, now: new Date(2026, 9, 6, 12, 0, 0) })
  assert.equal(result.fired.length, 0, "tidak boleh ada alert yang belum waktunya")
  assert.equal(deps.calls.filter(([n]) => n === "desktop").length, 0)
  assert.equal(deps.calls.filter(([n]) => n === "opencode").length, 0)
})

test("state lama dibersihkan supaya tidak tumbuh", () => {
  const cfg = cfgWith()
  const state = blankState()
  state.fired["lama-1"] = { at: new Date(Date.now() - 5 * 24 * 3600e3).toISOString() }
  state.fired["baru-1"] = { at: new Date().toISOString() }
  tick(cfg, state, { ...recorder(), now: new Date() })
  assert.equal(state.fired["lama-1"], undefined, "entri > 3 hari harus dibuang")
  assert.ok(state.fired["baru-1"], "entri hari ini harus bertahan")
})

// ----------------------------------------------------------------- config

test("config memuat dan menandai masalah", () => {
  const cfg = loadConfig()
  assert.equal(cfg.location.kota, "Semarang")
  assert.deepEqual(cfg.alerts.leadMinutes, [15, 5, 0, -5, -10])
  assert.equal(cfg.channels.desktop.enabled, true)
  assert.equal(cfg.channels.sound.enabled, false, "suara harus mati secara bawaan")
  assert.deepEqual(cfg.__problems, [], `config bermasalah: ${cfg.__problems.join("; ")}`)
})

test("forPrayer menggabungkan override dengan global", () => {
  const cfg = cfgWith({ alerts: { ...DEFAULTS.alerts, perPrayer: { isha: { leadMinutes: [0] } } } })
  assert.deepEqual(forPrayer(cfg, "isha").leadMinutes, [0])
  assert.deepEqual(forPrayer(cfg, "asr").leadMinutes, cfg.alerts.leadMinutes)
})

test("jam tenang lintas tengah malam dihitung benar", () => {
  const cfg = cfgWith({ quiet: { enabled: true, from: "22:30", to: "04:00" } })
  assert.equal(inQuietHours(cfg, new Date(2026, 9, 6, 23, 0)), true)
  assert.equal(inQuietHours(cfg, new Date(2026, 9, 6, 3, 0)), true)
  assert.equal(inQuietHours(cfg, new Date(2026, 9, 6, 12, 0)), false)
  const off = cfgWith()
  assert.equal(inQuietHours(off, new Date(2026, 9, 6, 3, 0)), false, "bawaan harus tidak ada jam tenang")
})
test("catch-up hanya membunyikan alert yang paling mendesak", () => {
  // Daemon hidup 5 menit sebelum sholat: H-15 (sudah 10 menit lewat) dan H-5
  // keduanya jatuh tempo. Hanya H-5 yang boleh berbunyi.
  const cfg = cfgWith()
  const state = blankState()
  const deps = recorder()
  const result = tick(cfg, state, { ...deps, now: new Date(2026, 9, 6, 3, 59, 0) })

  const leads = result.fired.map((f) => f.lead)
  assert.deepEqual(leads, [5], "hanya lead terdekat yang berbunyi")
  assert.ok(
    Object.values(state.fired).some((v) => String(v.skipped ?? "").startsWith("didahului")),
    "lead yang kalah harus dicatat, bukan diulang tiap tick",
  )
  assert.equal(deps.calls.filter(([n]) => n === "desktop").length, 1, "desktop tidak boleh dua kali")
})
