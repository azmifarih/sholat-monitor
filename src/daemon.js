// Daemon: sekali tiap tick, hitung jadwal lalu memicu alert kalau ada waktu
// sholat yang sudah cukup dekat.
//
// Prinsipnya: apa pun yang terjadi, daemon harus bisa merekonstruksi state-nya
// sendiri dari file. Kalau restart di tengah hari, dia tahu dari mana dia
// berhenti - bukan memicu ulang semua alert yang sudah lewat.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { schedule, atMinutes, ymd } from "./prayer-times.js"
import { loadConfig, forPrayer, inQuietHours } from "./config.js"
import * as desktopChannel from "./channels/desktop.js"
import * as opencodeChannel from "./channels/opencode.js"
import * as barChannel from "./channels/luvus-bar.js"
import * as luvusNotifChannel from "./channels/luvus-notification.js"
import { resolveLuvus } from "./luvus.js"
import * as soundChannel from "./channels/sound.js"
import { syncVendor } from "./sync.js"

// Direktori state. Bisa di-override lewat SHOLAT_STATE_DIR supaya test memakai
// direktori sendiri - test tidak boleh menulis ke state yang sedang dipakai
// daemon sungguhan.
const STATE_DIR = process.env.SHOLAT_STATE_DIR
  ? process.env.SHOLAT_STATE_DIR.replace(/^~(?=$|\/)/, homedir())
  : join(homedir(), ".local", "state", "sholat-monitor")
const STATE_FILE = join(STATE_DIR, "daemon-state.json")
const SNAPSHOT_FILE = join(STATE_DIR, "snapshot.json")
const LOG_FILE = join(STATE_DIR, "daemon.log")
const LOG_MAX_BYTES = 2 * 1024 * 1024

const LABEL = {
  fajr: "Shubuh",
  sunrise: "Terbit",
  dhuhr: "Dzuhur",
  asr: "Ashar",
  maghrib: "Maghrib",
  isha: "Isya",
}

const EMPTY_STATE = { fired: {}, ticks: 0, startedAt: null, lastTickAt: null, lastSyncAt: null, barOk: null }

// ---------------------------------------------------------------- logging

// Kegagalan menulis dicatat sekali per jenis error. Tanpa itu, daemon bisa
// berjalan berjam-jam tanpa jejak sama sekali: service-nya "active", tidak ada
// error, tidak ada file - dan tidak ada cara tahu ada yang salah.
let reportedWriteFailure = null

export function log(line) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19)
  const text = `[${stamp}] ${line}`
  console.log(text)
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    // Log diputar sendiri: daemon berjalan berbulan-bulan, file log tidak boleh
    // tumbuh tanpa batas.
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      writeFileSync(LOG_FILE, `${text} (log diputar)\n`)
    } else {
      appendFileSync(LOG_FILE, text + "\n")
    }
    reportedWriteFailure = null
  } catch (error) {
    // Satu kali per kombinasi error, supaya tidak membanjiri journal tiap menit.
    const reason = `${error.code ?? error.message}`
    if (reportedWriteFailure !== reason) {
      reportedWriteFailure = reason
      console.error(`[${stamp}] PERINGATAN: tidak bisa menulis ke ${STATE_DIR} (${reason}).`)
      console.error(`[${stamp}] Alert mungkin tetap terkirim, tapi state tidak tersimpan.`)
      console.error(`[${stamp}] Periksa: systemctl --user show sholat-monitor -p ProtectHome -p ReadWritePaths`)
    }
  }
}

// ------------------------------------------------------------------ state

export function loadState() {
  // `fired` harus objek baru, bukan rujukan ke EMPTY_STATE. Dengan shallow copy,
  // semua pemanggil dalam satu proses akan menulis ke peta yang sama dan saling
  // menimpa - muncul sebagai "alert hilang" atau "alert dobel".
  const blank = () => ({ fired: {}, ticks: 0, startedAt: null, lastTickAt: null, lastSyncAt: null, barOk: null })
  try {
    if (!existsSync(STATE_FILE)) return blank()
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"))
    return { ...blank(), ...parsed, fired: parsed.fired ?? {} }
  } catch (error) {
    log(`state tidak terbaca, mulai dari nol: ${error.message}`)
    return blank()
  }
}

export function saveState(state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n")
  } catch (error) {
    log(`gagal menyimpan state: ${error.message}`)
  }
}

// ---------------------------------------------------------------- planning

/**
 * Semua momen yang perlu memicu alert: yang akan datang dalam 24 jam, plus yang
 * sudah lewat tapi masih dalam toleransi (biar daemon yang baru hidup setelah
 * restart singkat, daemon tetap memberi tahu).
 * `id` dipakai sebagai kunci supaya satu momen tidak memicu dua kali.
 */
export function plan(cfg, now) {
  const events = []
  const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  const toleranceMs = cfg.alerts.lateToleranceMinutes * 60_000
  const earliest = new Date(now.getTime() - toleranceMs)

  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset)
    const s = schedule(base, { ...cfg, now })
    const dayData = dayOffset === 0 ? s.today : s.tomorrow

    for (const prayerKey of cfg.alerts.prayers) {
      const clock = dayData.times[prayerKey]
      const minutes = dayData.minutes[prayerKey]
      if (!clock || minutes === undefined) continue

      const prayerAt = atMinutes(base, minutes)
      const per = forPrayer(cfg, prayerKey)

      for (const lead of per.leadMinutes) {
        const when = new Date(prayerAt.getTime() - lead * 60_000)
        // Yang sudah lewat lebih dari toleransi tidak masuk daftar sama sekali:
        // sudah terlewat; memicunya hanya jadi bunyi untuk masa lalu.
        if (when > horizon || when < earliest) continue
        events.push({
          id: `${ymd(prayerAt)}-${prayerKey}@${lead}`,
          prayerKey,
          prayerAt,
          clock,
          lead,
          label: LABEL[prayerKey] ?? prayerKey,
          when,
          quiet: inQuietHours(cfg, when),
          overrides: per,
        })
      }
    }
  }

  events.sort((a, b) => a.when - b.when)
  return events
}

// ---------------------------------------------------------------- delivery

export function alertText(cfg, event) {
  const lead = event.lead
  const when =
    lead > 0
      ? lead === 1
        ? "1 menit lagi"
        : `${lead} menit lagi`
      : lead === 0
        ? "sekarang waktunya"
        : `sudah lewat ${-lead} menit`
  const tomorrow = ymd(event.prayerAt) !== ymd(new Date())
  return {
    id: event.id,
    level: lead <= 5 ? "warning" : "info",
    title: "Waktu Sholat",
    body: `${when} — ${event.label} ${event.clock} · ${cfg.location.kota}${tomorrow ? " (besok)" : ""}`,
    // Lead negatif (pengingat sesudah waktunya) ikut kritis: alasannya sama
    // seperti H-0 - pengingat "sudah telat" justru harus menempel sampai
    // dilihat, bukan hilang sendiri sementara orangnya sedang asyik bekerja.
    critical: lead <= 5,
    minutesLeft: lead,
    durationMs: lead === 0 ? 30_000 : 20_000,
  }
}

/**
 * Kirim satu alert ke channel yang relevan. Setiap channel independen: kalau
 * satu gagal, yang lain tetap mencoba.
 */
export function deliver(cfg, event, deps = {}) {
  const desktop = deps.desktop ?? desktopChannel
  const opencode = deps.opencode ?? opencodeChannel
  const sound = deps.sound ?? soundChannel
  const luvusNotif = deps.luvusNotification ?? luvusNotifChannel

  const alert = alertText(cfg, event)
  const results = {}

  // Desktop lebih dulu: ini yang benar-benar kelihatan kalau TUI tertutup.
  if (event.overrides.desktop !== false) {
    results.desktop = desktop.desktop(cfg.channels.desktop, alert)
  }

  if (cfg.channels.opencode.enabled && cfg.channels.opencode.atLeadMinutes.includes(event.lead)) {
    results.opencode = opencode.opencode(cfg.channels.opencode, alert)
  }

  // Toast + notification center Luvus. Di-gate sama ketatnya dengan toast TUI
  // (atLeadMinutes), karena keduanya adalah permukaan yang sama-sama berisik -
  // desktop sudah mengambil semua lead tanpa filter.
  const luvusCfg = cfg.channels.luvusNotification
  if (
    luvusCfg?.enabled &&
    event.overrides.luvusNotification !== false &&
    luvusCfg.atLeadMinutes.includes(event.lead)
  ) {
    results.luvus = luvusNotif.luvusNotification(luvusCfg, alert)
  }

  if (event.overrides.sound !== false && cfg.channels.sound.atLeadMinutes.includes(event.lead)) {
    results.sound = sound.sound(cfg.channels.sound, alert, log)
  }

  return { alert, results }
}

// -------------------------------------------------------------------- tick

// Channel yang sengaja dimatikan di config bukan kegagalan. Menandainya sebagai
// "gagal" bikin log berbohong tentang kotak merah yang tidak ada masalahnya.
function resultLabel(r) {
  if (r?.ok) return "ok"
  if (/dimatikan/i.test(r?.reason ?? "")) return "nonaktif"
  return `gagal (${r?.reason ?? "alasan tidak diketahui"})`
}

// Penanda lead untuk log: 15 = H-15, -10 = H+10 (sudah lewat 10 menit).
// H--10 rangkap minus terbaca seperti salah ketik, padahal bukan.
export function hTag(lead) {
  return lead >= 0 ? `H-${lead}` : `H+${-lead}`
}

/** Satu putaran. Dipisah supaya bisa diuji tanpa menunggu waktu nyata. */
export function tick(cfg, state, deps = {}) {
  const now = deps.now ?? new Date()
  const bar = deps.bar ?? barChannel

  state.ticks += 1
  state.lastTickAt = now.toISOString()

  // Bar widget selalu direpaint supaya hitungan mundurnya tetap hidup,
  // walaupun tidak ada alert yang jatuh tempo.
  //
  // Hasilnya dicatat HANYA saat berubah (ok -> gagal atau sebaliknya). Kalau
  // dicatat tiap tick, log jadi satu baris per menit dan justru menyembunyikan
  // alert. Kalau tidak dicatat sama sekali, bar bisa mati diam-diam selama
  // berhari-hari - persis kegagalan yang pernah terjadi: service hijau, jadwal
  // benar, tapi widget beku di sholat yang salah.
  const barResult = bar.luvusBar(cfg.channels.luvusBar, null)
  const barOk = Boolean(barResult?.ok)
  if (state.barOk !== barOk) {
    log(barOk ? "bar ok (widget hidup lagi)" : `bar GAGAL: ${barResult?.reason ?? "alasan tidak diketahui"}`)
    state.barOk = barOk
  }

  const fired = []
  const events = plan(cfg, now)

  // Kalau daemon baru hidup setelah downtime, beberapa alert bisa sudah lewat
  // dalam toleransi (mis. start 5 menit sebelum sholat: H-15 dan H-5 keduanya
  // sudah jatuh tempo). Yang didengar hanya yang paling mendesak - soal
  // "sudah waktunya" sudah dijawab oleh yang paling dekat.
  const overdueByPrayer = new Map()
  for (const event of events) {
    if (event.when > now) continue
    const seen = overdueByPrayer.get(event.prayerKey)
    if (!seen || event.lead < seen.lead) overdueByPrayer.set(event.prayerKey, event)
  }

  for (const event of events) {
    if (state.fired[event.id]) continue

    // Penjaga utama: waktu picu belum tiba. Tanpa baris ini, semua event dalam
    // horizon 24 jam akan memicu sekaligus pada tick pertama.
    if (event.when > now) continue

    // Terlalu lama terlewat karena daemon mati: tandai sudah lewat supaya
    // tidak meledak jadi banyak alert sekaligus saat daemon menyala lagi.
    const lateBy = now - event.when
    if (lateBy > cfg.alerts.lateToleranceMinutes * 60_000) {
      state.fired[event.id] = { at: now.toISOString(), skipped: "terlambat" }
      continue
    }

    // Ada yang lebih mendesak untuk sholat yang sama: jangan jadi bising.
    const urgent = overdueByPrayer.get(event.prayerKey)
    if (urgent && urgent.id !== event.id) {
      state.fired[event.id] = { at: now.toISOString(), skipped: `didahului ${urgent.lead}` }
      continue
    }

    if (event.quiet) {
      state.fired[event.id] = { at: now.toISOString(), skipped: "jam-tenang" }
      log(`lewati (jam tenang): ${event.label} ${event.clock} ${hTag(event.lead)}`)
      continue
    }

    const { alert, results } = deliver(cfg, event, deps)
    state.fired[event.id] = { at: now.toISOString(), results }
    fired.push({ ...event, alert, results })
    log(
      `ALERT ${event.label} ${event.clock} ${hTag(event.lead)} -> ` +
        Object.entries(results)
          .map(([name, r]) => `${name}:${resultLabel(r)}`)
          .join(" "),
    )
  }

  // Buang riwayat yang sudah lewat 3 hari supaya file state tidak tumbuh.
  const keepAfter = now.getTime() - 3 * 24 * 60 * 60 * 1000
  for (const [id, entry] of Object.entries(state.fired)) {
    if (new Date(entry.at).getTime() < keepAfter) delete state.fired[id]
  }

  return { fired, barResult }
}

// -------------------------------------------------------------------- sync

function maybeSync(cfg, state) {
  const now = new Date()
  if (!(cfg.daemon.syncDays > 0)) return
  const [h, m] = String(cfg.daemon.syncAt).split(":").map(Number)
  if (now.getHours() !== h || now.getMinutes() >= 5) return
  if (state.lastSyncAt && now - new Date(state.lastSyncAt) < cfg.daemon.syncDays * 24 * 60 * 60 * 1000) return

  const result = syncVendor(log)
  state.lastSyncAt = now.toISOString()
  if (result.updated) log(`vendor/PrayTimes.js diperbarui dari landak (${result.reason})`)
  else if (result.differs) log(`PERINGATAN: PrayTimes.js di landak berubah, gagal update: ${result.reason}`)
}

// ----------------------------------------------------------------- snapshot

/** Ringkasan untuk manusia dan tool lain: jadwal hari ini + sholat berikutnya. */
export function writeSnapshot(cfg) {
  const now = new Date()
  const s = schedule(now, { ...cfg, now })
  const snapshot = {
    updatedAt: now.toISOString(),
    kota: cfg.location.kota,
    today: { date: s.today.date, times: s.today.times },
    tomorrow: { date: s.tomorrow.date, times: s.tomorrow.times },
    next: s.next && {
      key: s.next.key,
      label: s.next.label,
      time: s.next.time,
      at: s.next.at.toISOString(),
      tomorrow: s.next.tomorrow,
      minutesLeft: s.next.minutesLeft,
    },
  }
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2) + "\n")
  } catch {
    // Snapshot hanya informasi. Kegagalannya sudah ketahuan lewat log().
  }
  return snapshot
}

// --------------------------------------------------------------------- loop

export function run(cfg = loadConfig(), deps = {}) {
  const state = loadState()
  state.startedAt = state.startedAt ?? new Date().toISOString()
  for (const problem of cfg.__problems ?? []) log(`config: ${problem}`)
  log(`daemon mulai, pid ${process.pid}, tick ${cfg.daemon.tickSeconds}s`)

  // Sesi Luvus yang dipakai dicatat sekali di awal. Ini yang membuat "kok tidak
  // ada toast?" bisa dijawab langsung: "env-usang" berarti LUVUS_SESSION di unit
  // sudah tidak menunjuk sesi yang hidup, dan daemon pindah sesi sendiri -
  // jadi tidak perlu ada yang menebak.
  const luvus = resolveLuvus()
  log(`sesi luvus: ${luvus.session ?? "tidak ada sesi running"} (${luvus.source}; hidup: ${luvus.running.join(", ") || "-"})`)

  writeSnapshot(cfg)

  let stopping = false
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (stopping) return
      stopping = true
      log(`menerima ${signal}, berhenti`)
      saveState(state)
      process.exit(0)
    })
  }

  const loop = () => {
    try {
      maybeSync(cfg, state)
      tick(cfg, state, deps)
      writeSnapshot(cfg)
    } catch (error) {
      // Satu tick yang gagal tidak boleh mematikan daemon.
      log(`tick gagal: ${error?.stack || error?.message || error}`)
    }
    saveState(state)
  }

  loop()
  const interval = setInterval(loop, cfg.daemon.tickSeconds * 1000)
  // Jaga proses tetap hidup meski interval di-unref (dipakai untuk tes).
  if (deps.keepAlive === false) interval.unref?.()
  else setInterval(() => {}, 1 << 30)
}

export { STATE_DIR, STATE_FILE, SNAPSHOT_FILE, LOG_FILE, LABEL }