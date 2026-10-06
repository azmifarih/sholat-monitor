// Perhitungan waktu sholat dengan engine yang PERSIS sama dengan yang dipakai
// https://shalat.landak.com/?kota=... : PrayTimes.js (Khalid Shukri, MIT) dengan
// setelan yang sama persis dengan yang dipanggil halaman itu.
//
// Halaman landak menjalankan:
//   prayTimes.adjust({fajr:20, dhuhr:'2 min', maghrib:1, isha:18})
//   prayTimes.tune({fajr:1, sunrise:-2, asr:2, maghrib:2, isha:1})
//   prayTimes.getTimes(tgl, [lat, lng], tzOffset, 0, '24h')
//
// Jadi angka kita = angka situs, bukan "mirip". Semua parameter tetap bisa
// dioverride lewat config (lihat DEFAULT_PARAMS / applyOverrides).

import { readFileSync } from "node:fs"
import vm from "node:vm"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

let ctx
function engine() {
  if (!ctx) {
    ctx = vm.createContext({ Date, Math, Intl })
    vm.runInContext(readFileSync(join(ROOT, "vendor", "PrayTimes.js"), "utf8"), ctx)
  }
  return ctx
}

// Urutan resmi; sunrise/sunset tidak termasuk waktu sholat.
export const PRAYERS = [
  { key: "imsak", label: "Imsak", arabic: "إمساك" },
  { key: "fajr", label: "Shubuh", arabic: "فجر" },
  { key: "sunrise", label: "Terbit", arabic: "" },
  { key: "dhuhr", label: "Dzuhur", arabic: "ظهر" },
  { key: "asr", label: "Ashar", arabic: "عصر" },
  { key: "sunset", label: "Terbenam", arabic: "" },
  { key: "maghrib", label: "Maghrib", arabic: "مغرب" },
  { key: "isha", label: "Isya", arabic: "عشاء" },
]

// Yang dipakai situs landak (jika kamu ubah, angkaMU berubah, bukan angka situs).
export const DEFAULT_PARAMS = {
  method: "MWL",
  imsak: "10 min",
  fajr: 20, // derajat di bawah horizon
  isha: 18, // derajat di bawah horizon
  maghrib: 1, // derajat di bawah horizon
  dhuhr: "2 min", // jeda aman setelah zenith
  asr: "Standard", // Standard = Syafi'i/Maliki/Hanbali; "Hanafi" = Hanafi
  highLats: "NightMiddle",
  midnight: "Standard",
}

// Penyesuaian menit per sholat, sama seperti tune() di situs.
export const DEFAULT_TUNE = { fajr: 1, sunrise: -2, asr: 2, maghrib: 2, isha: 1 }

// Koordinat kota. Default = Semarang, sama seperti yang dipakai halaman landak.
export const DEFAULT_LOCATION = { kota: "Semarang", lat: -6.9666667, lng: 110.4166667, tz: 7 }

/**
 * Hitung satu hari.
 * @param {Date} day tanggal (komponen lokal dipakai; daemon jalan di Asia/Jakarta)
 * @param {object} o { lat, lng, tz, params, tune, ihtiyati, koreksi }
 */
export function computeDay(day, o = {}) {
  const loc = { ...DEFAULT_LOCATION, ...(o.location ?? {}) }
  const params = { ...DEFAULT_PARAMS, ...(o.params ?? {}) }
  const tune = { ...DEFAULT_TUNE, ...(o.tune ?? {}) }
  const ihtiyati = o.ihtiyati ?? 0 // detik pengaman, dikurangi dari semua waktu
  const koreksi = o.koreksi ?? {} // koreksi manual per sholat, dalam menit

  const PT = engine().prayTimes
  PT.setMethod(params.method)
  PT.adjust(params)
  PT.tune(tune)

  const raw = PT.getTimes(day, [loc.lat, loc.lng], String(loc.tz), 0, "Float")
  const at = PT.getTimes(day, [loc.lat, loc.lng], String(loc.tz), 0, "24h")

  const times = {}
  const minutes = {}
  for (const p of PRAYERS) {
    const t = at[p.key]
    if (!t) continue
    let [h, m] = t.split(":").map(Number)
    let min = h * 60 + m
    // koreksi manual, lalu ihtiyati (detik -> pecahan menit)
    min += koreksi[p.key] ?? 0
    min -= ihtiyati / 60
    min = ((Math.round(min) % 1440) + 1440) % 1440
    minutes[p.key] = min
    times[p.key] = `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`
  }

  return { kota: loc.kota, date: ymd(day), params, tune, times, minutes, rawMinutes: raw }
}

export function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function atMinutes(day, min) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(min / 60), Math.round(min % 60))
}

/**
 * Jadwal hari ini + besok, dan sholat berikutnya yang belum masuk waktu.
 * `prayersOnly` = waktu Kiblat (Shubuh..Isya) tanpa Terbit/Terbenam/Imsak.
 */
export function schedule(day, o = {}) {
  const only = o.prayersOnly ?? true
  const today = computeDay(day, o)
  const tomorrow = computeDay(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1), o)
  const list = PRAYERS.filter((p) => (only ? ["fajr", "dhuhr", "asr", "maghrib", "isha"].includes(p.key) : true))

  // `now` bisa di-override supaya hasil schedule() deterministik di test.
  // Tanpa itu, test jadi bergantung tanggal nyata dan gagal sendiri begitu
  // tengah malam berganti.
  const now = o.now ?? new Date()
  let next = null
  for (const [offset, dayData] of [[0, today], [1, tomorrow]]) {
    // Basis tanggal ikut bergeser, kalau tidak waktu besok salah hitung ke hari ini.
    const base = new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset)
    for (const p of list) {
      const when = atMinutes(base, dayData.minutes[p.key])
      if (when.getTime() <= now.getTime()) continue
      next = {
        key: p.key,
        label: p.label,
        arabic: p.arabic,
        time: dayData.times[p.key],
        date: offset === 0 ? today.date : tomorrow.date,
        tomorrow: offset === 1,
        at: when,
        minutesLeft: Math.round((when.getTime() - now.getTime()) / 60000),
      }
      break
    }
    if (next) break
  }

  return { today, tomorrow, next, now: now.toISOString() }
}

export function fmtCountdown(mins) {
  if (mins <= 0) return "sekarang"
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}j`
  return `${h}j ${String(m).padStart(2, "0")}m`
}