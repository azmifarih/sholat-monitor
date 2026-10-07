// Pemuat konfigurasi: JSONC (bisa dikomentari), default, validasi.
//
// Kenapa JSONC: file ini memang untuk dibaca manusia yang mau ubah satu angka
// jam atau satu nama kota. Komentar sebaris membuat aman untuk diubah; JSON biasa
// memaksa orang mengira-ira struktur.

import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
export const CONFIG_PATH = join(ROOT, "config.json")

/** Buang komentar // dan /* *\/ tanpa merusak string di dalamnya. */
export function stripJsonComments(input) {
  let out = ""
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    const next = input[i + 1]
    if (inLine) {
      if (c === "\n") {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += c
      if (c === "\\") {
        out += next ?? ""
        i++
      } else if (c === '"') {
        inString = false
      }
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === "/" && next === "/") {
      inLine = true
      i++
      continue
    }
    if (c === "/" && next === "*") {
      inBlock = true
      i++
      continue
    }
    out += c
  }
  return out
}

export const DEFAULTS = {
  location: { kota: "Semarang", lat: -6.9666667, lng: 110.4166667, tz: 7 },
  params: { method: "MWL", imsak: "10 min", fajr: 20, isha: 18, maghrib: 1, dhuhr: "2 min", asr: "Standard", highLats: "NightMiddle" },
  tune: { fajr: 1, sunrise: -2, asr: 2, maghrib: 2, isha: 1 },
  // Pengaman (detik) yang dikurangi dari setiap waktu. Default 0 supaya angka
  // persis sama dengan situs landak; naikkan bila mau lebih aman.
  ihtiyati: 0,
  // Koreksi manual per sholat, dalam menit. Pakai kalau masjidmu terasa lebih
  // cepat atau lebih lambat dari jadwal ini.
  koreksi: {},

  alerts: {
    // Menit sebelum waktu sholat untuk memicu alert. 15 = info, 5 = serius,
    // 0 = sekarang waktunya. Negatif = pengingat sesudah waktunya
    // (-5 = "sudah lewat 5 menit"), dipakai untuk mengejar yang terlewat.
    leadMinutes: [15, 5, 0, -5, -10],
    // Sholat mana yang diawasi.
    prayers: ["fajr", "dhuhr", "asr", "maghrib", "isha"],
    // Kalau daemon mati dan menyala lagi, alert yang telat lebih dari ini
    // dianggap terlewat - tidak dipicu (biar tidak meledak bertubi-tubi).
    lateToleranceMinutes: 20,
    // Override per sholat: { isha: { leadMinutes: [5], desktop: false } }
    perPrayer: {},
  },

  channels: {
    desktop: {
      enabled: true,
      // Seberapa dekat waktunya notifikasi jadi "critical" (tidak ilang sendiri).
      criticalAtMinutes: 5,
      // 0 = tidak ilang sendiri (pakai critical), selain itu milliseconds.
      timeoutMs: 0,
      sound: false,
      appName: "Waktu Sholat",
      icon: "org.gnome.clocks",
    },
    opencode: {
      enabled: true,
      // Tulis alert.json hanya untuk lead ini saja, biar tidak spam.
      // -5/-10 = pengingat sesudah waktunya, ikut dikirim supaya toast di TUI
      // juga mengejar yang terlewat, bukan hanya notifikasi desktop.
      atLeadMinutes: [5, 0, -5, -10],
      // Tulis LUVUS_PANE_ID pane yang sedang fokus, supaya hanya TUI yang
      // sedang dilihat yang berteriak.
      targetFocusedPane: true,
    },
    luvusBar: { enabled: true },
    sound: {
      enabled: false,
      // Adhan diambil dari server landak yang sama dengan sumber jadwal.
      url: "http://shalat.landak.com/Adhan Makkah.mp3",
      file: "~/.local/state/sholat-monitor/adhan-makkah.mp3",
      player: "auto",
      volume: 40,
      atLeadMinutes: [0],
    },
    // Tidak dipakai: notifikasi dan toast Luvus sengaja dibiarkan seperti
    // adanya. Bar widget (channels.luvusBar) tetap aktif.
    luvusNotification: { enabled: false },
  },

  // Jam tenang: alert yang jatuh di rentang ini dilewati. Sepanjang malam
  // misalnya, supaya adhan jam 4 pagi tidak membangunkan semua orang.
  quiet: { enabled: false, from: "22:30", to: "04:00" },

  daemon: {
    tickSeconds: 60,
    // Sekali sehari, bandingkan vendor/PrayTimes.js dengan yang ada di server
    // landak. Kalau upstream berubah, bunyi di log - angka kita ikut berubah
    // setelah file di-update.
    syncDays: 1,
    syncAt: "03:20",
  },
}

const PRAYER_KEYS = ["imsak", "fajr", "sunrise", "dhuhr", "asr", "sunset", "maghrib", "isha"]

function deepMerge(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value)
    } else {
      out[key] = value
    }
  }
  return out
}

function toMinutes(hhmm) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ""))
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * Muat config dan validasi. Jangan pernah diam-diam memakai default kalau file
 * ada tapi rusak: itu sumber alert yang salah tanpa jejak.
 */
export function loadConfig(path = CONFIG_PATH) {
  const problems = []
  let raw = {}
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8")
    try {
      raw = JSON.parse(stripJsonComments(text))
    } catch (error) {
      throw new Error(`${path} bukan JSON yang valid: ${error.message}`)
    }
  } else {
    problems.push(`${path} tidak ada; memakai default`)
  }

  const cfg = deepMerge(DEFAULTS, raw)

  // --- validasi yang bisa merusak keadaan kalau lolos -------------
  if (typeof cfg.location.lat !== "number" || typeof cfg.location.lng !== "number") problems.push("location.lat/lng harus angka")
  if (!Number.isFinite(cfg.location.tz)) problems.push("location.tz harus angka, misal 7 untuk WIB")
  if (!Array.isArray(cfg.alerts.leadMinutes) || cfg.alerts.leadMinutes.some((n) => typeof n !== "number")) problems.push("alerts.leadMinutes harus array angka")
  for (const key of cfg.alerts.prayers) {
    if (!PRAYER_KEYS.includes(key)) problems.push(`alerts.prayers punya "${key}" yang bukan nama sholat`)
  }
  for (const key of Object.keys(cfg.alerts.perPrayer)) {
    if (!PRAYER_KEYS.includes(key)) problems.push(`alerts.perPrayer punya "${key}" yang bukan nama sholat`)
  }
  if (cfg.quiet.enabled) {
    const from = toMinutes(cfg.quiet.from)
    const to = toMinutes(cfg.quiet.to)
    if (from === null || to === null) problems.push('quiet.from/to harus format "HH:MM"')
  }
  if (cfg.daemon.tickSeconds < 5) problems.push("daemon.tickSeconds minimal 5")

  cfg.__problems = problems
  return cfg
}

/** Override per sholat, digabung dengan setelan global. */
export function forPrayer(cfg, prayerKey) {
  const per = cfg.alerts.perPrayer?.[prayerKey] ?? {}
  return {
    leadMinutes: per.leadMinutes ?? cfg.alerts.leadMinutes,
    desktop: per.desktop,
    opencode: per.opencode,
    sound: per.sound,
  }
}

/** Apakah `when` jatuh di dalam jam tenang? */
export function inQuietHours(cfg, when = new Date()) {
  if (!cfg.quiet.enabled) return false
  const from = toMinutes(cfg.quiet.from)
  const to = toMinutes(cfg.quiet.to)
  if (from === null || to === null) return false
  const now = when.getHours() * 60 + when.getMinutes()
  // Rentang bisa melewati tengah malam (22:30 -> 04:00).
  return from <= to ? now >= from && now < to : now >= from || now < to
}