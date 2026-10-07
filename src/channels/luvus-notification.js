// Channel Luvus: toast sebaris + entri notification center milik Luvus.
//
// Ini rumah aslinya alert di UI Luvus. Berbeda dengan channel desktop
// (notify-send) yang muncul di atas semua window, dan berbeda dengan toast
// plugin OpenCode yang hanya hidup di dalam pane TUI: `luvus ui toast`
// berkedip di UI Luvus yang sedang aktif, dan `notification push` masuk ke
// daftar notifikasi yang bisa dibaca ulang kapan saja.
//
// Sebelum channel ini ada, config hanya punya stub `luvusNotification`
// nonaktif - jadi "toast dan notification Luvus" memang tidak pernah menerima
// alert apa pun, bukan ketinggalan update.

import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { luvusBin, runLuvus, failureReason } from "../luvus.js"

export function available() {
  const bin = luvusBin()
  // Kalau LUVUS_BIN_PATH menunjuk path lengkap, `command -v` tidak relevan -
  // yang benar adalah memeriksa berkasnya. Kalau tidak, baru cari di PATH.
  if (bin.includes("/")) return existsSync(bin)
  return spawnSync("command", ["-v", bin], { shell: true, encoding: "utf8" }).status === 0
}

export function luvusNotification(cfg, alert) {
  if (!cfg.enabled) return { ok: false, reason: "dimatikan di config" }

  const text = alert.body

  // Kedua langkah dijalankan keduanya, bukan berhenti di yang pertama gagal:
  // toast gagal masih ada notification, dan sebaliknya. Lapor kegagalan
  // pertama yang ditemukan supaya log menunjuk ke masalah yang nyata.
  const failures = []

  // runLuvus, bukan spawnSync langsung: sesi Luvus diurus di satu tempat
  // (src/luvus.js), dan kegagalannya diterjemahkan jadi alasan yang terbaca.
  const toast = runLuvus(["ui", "toast", text])
  if (toast.status !== 0) failures.push(`toast: ${failureReason(toast)}`)

  // level alert (info|warning) langsung cocok dengan --level milik Luvus.
  const level = ["info", "success", "warning", "error"].includes(alert.level) ? alert.level : "info"
  const push = runLuvus(["ui", "notification", "push", "--text", text, "--level", level])
  if (push.status !== 0) failures.push(`notification: ${failureReason(push)}`)

  if (failures.length > 0) return { ok: false, reason: failures.join("; ") }
  return { ok: true }
}
