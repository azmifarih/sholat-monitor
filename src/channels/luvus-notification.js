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

import { spawnSync } from "node:child_process"

function run(luvus, args) {
  return spawnSync(luvus, args, { encoding: "utf8", timeout: 10_000 })
}

export function available() {
  const r = spawnSync("command", ["-v", "luvus"], { shell: true, encoding: "utf8" })
  return r.status === 0
}

export function luvusNotification(cfg, alert) {
  if (!cfg.enabled) return { ok: false, reason: "dimatikan di config" }

  // Pakai binary yang sedang berjalan kalau ada (sama seperti channel bar):
  // PATH bisa menunjuk versi lain, dan socket yang benar adalah yang ini.
  const luvus = process.env.LUVUS_BIN_PATH ?? "luvus"
  const text = alert.body

  // Kedua langkah dijalankan keduanya, bukan berhenti di yang pertama gagal:
  // toast gagal masih ada notification, dan sebaliknya. Lapor kegagalan
  // pertama yang ditemukan supaya log menunjuk ke masalah yang nyata.
  const failures = []

  const toast = run(luvus, ["ui", "toast", text])
  if (toast.status !== 0) failures.push(`toast: ${toast.stderr?.trim() || `exit ${toast.status}`}`)

  // level alert (info|warning) langsung cocok dengan --level milik Luvus.
  const level = ["info", "success", "warning", "error"].includes(alert.level) ? alert.level : "info"
  const push = run(luvus, ["ui", "notification", "push", "--text", text, "--level", level])
  if (push.status !== 0) failures.push(`notification: ${push.stderr?.trim() || `exit ${push.status}`}`)

  if (failures.length > 0) return { ok: false, reason: failures.join("; ") }
  return { ok: true }
}
