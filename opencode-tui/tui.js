// CLI (TUI) plugin OpenCode V2 - menampilkan alert waktu sholat.
//
// Daemon `sholat` menulis ~/.local/state/sholat-monitor/alert.json setiap kali
// ada waktu sholat yang sudah dekat. Plugin ini poll file itu, lalu memunculkan
// toast di dalam TUI dan (opsional) system notification + suara.
//
// Kontrak V2 CLI plugin: default export { id, setup(context) }.
// Dipakai: context.ui.toast.show(), context.attention.notify().

import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const STATE_DIR = join(homedir(), ".local", "state", "sholat-monitor")
const ALERT_FILE = join(STATE_DIR, "alert.json")
const LOG_FILE = join(STATE_DIR, "plugin.log")

// Poll tiap 5 detik. File ditulis daemon, jadi poll sederhana sudah cukup dan
// tidak perlu menahan file descriptor yang harus diurus saat TUI tutup.
// Override dengan SHOLAT_ALERT_POLL_MS kalau mau lebih responsif.
const POLL_MS = Number(process.env.SHOLAT_ALERT_POLL_MS ?? 5_000)

// Pane Luvus tempat proses ini hidup. Tiap TUI di dalam pane Luvus mewarisi
// LUVUS_PANE_ID, jadi inilah cara plugin tahu "apakah aku yang sedang dilihat".
// Di luar Luvus (opencode standalone) nilainya kosong.
const MY_PANE = process.env.LUVUS_PANE_ID ?? null

// Id alert yang sudah ditampilkan. Tanpa ini, reload plugin akan memunculkan
// notifikasi yang sama berulang kali.
let lastSeenId = null

// Breadcrumb: plugin ini benar-benar dimuat TUI atau tidak. Tanpa ini, "tidak
// ada notifikasi" tidak bisa dibedakan dari "plugin-nya tidak jalan".
function breadcrumb(event, extra = {}) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${event} ${JSON.stringify(extra)}\n`)
  } catch {
    // Logging tidak boleh menjatuhkan plugin.
  }
}

function readAlert() {
  try {
    if (!existsSync(ALERT_FILE)) return null
    const raw = readFileSync(ALERT_FILE, "utf8").trim()
    if (!raw) return null
    const alert = JSON.parse(raw)
    if (!alert?.id || !alert?.message) return null
    return alert
  } catch {
    // File sedang ditulis daemon: coba lagi pada poll berikutnya.
    return null
  }
}

export default {
  id: "sholat.alert",

  setup(context) {
    breadcrumb("loaded", { pid: process.pid, pollMs: POLL_MS })

    function check() {
      const alert = readAlert()
      if (!alert || alert.id === lastSeenId) return

      // Targeting per-pane: kalau daemon tahu pane Luvus yang sedang fokus,
      // hanya TUI di pane itu yang berteriak. Tanpa ini semua TUI yang terbuka
      // akan toast bersamaan, jadi alarmnya jadi tidak berguna.
      // Sengaja tidak ditandai sebagai "sudah dilihat": kalau kamu pindah pane
      // sebelum waktunya lewat, alert itu masih bisa muncul di pane yang baru.
      if (alert.pane && MY_PANE && alert.pane !== MY_PANE) return

      lastSeenId = alert.id
      breadcrumb("alert", { id: alert.id, pane: MY_PANE, target: alert.pane ?? null })

      const title = alert.title ?? "Waktu Sholat"

      // Toast di dalam TUI - selalu kelihatan kalau TUI sedang aktif.
      context.ui.toast.show({
        title,
        message: alert.message,
        variant: alert.level ?? "info",
        duration: alert.duration ?? 15_000,
      })

      // System notification + suara - untuk saat TUI sedang tidak dipantau
      // (mis. kamu sedang di browser atau terminal lain).
      // Alert dengan "desktop": false hanya memunculkan toast.
      if (alert.desktop !== false) {
        context.attention
          .notify({
            title,
            message: alert.message,
            // "always", bukan "blurred": kalau TUI tidak tahu status fokus,
            // "blurred" akan di-skip (focus_unknown) dan notifikasi hilang.
            notification: alert.critical === true ? { when: "always" } : { when: "always" },
            sound: alert.sound !== false ? { name: "done", when: "always" } : false,
          })
          .then((result) => breadcrumb("notify", { ok: result?.ok, notification: result?.notification, sound: result?.sound, skipped: result?.skipped ?? null }))
          .catch((error) => breadcrumb("notify-failed", { error: String(error) }))
      }
    }

    const timer = setInterval(check, POLL_MS)

    // Cek langsung sekali, supaya alert yang ditulis saat TUI nutup tetap
    // tampil ketika plugin ini dimuat.
    check()

    return () => clearInterval(timer)
  },
}