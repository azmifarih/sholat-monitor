// Channel desktop: notifikasi GNOME lewat notify-send.
//
// Ini yang benar-benar merebut perhatian: toast di dalam TUI bisa tertutup
// window lain. notify-send tidak bisa membuktikan apakah user benar-benar
// melihatnya, jadi yang dipakai adalah yang tidak ilang sendiri.

import { spawnSync } from "node:child_process"

function have(bin) {
  const r = spawnSync("command", ["-v", bin], { shell: true, encoding: "utf8" })
  return r.status === 0
}

export function available() {
  return have("notify-send")
}

export function desktop(cfg, alert) {
  if (!cfg.enabled || !available()) return { ok: false, reason: "notify-send tidak ada" }

  const minutesLeft = alert.minutesLeft
  const critical = minutesLeft <= cfg.criticalAtMinutes
  // 0 berarti "jangan ilang sendiri"; hanya bermakna bersama critical.
  const timeout = critical ? 0 : cfg.timeoutMs > 0 ? cfg.timeoutMs : 15_000

  const args = [
    `--app-name=${cfg.appName}`,
    `--icon=${cfg.icon}`,
    `--urgency=${critical ? "critical" : "normal"}`,
    `--expire-time=${timeout}`,
    "--hint=boolean:transient:false",
  ]
  if (cfg.sound) args.push("--hint=string:sound-name:glass")

  args.push(alert.title, alert.body)

  const res = spawnSync("notify-send", args, { encoding: "utf8", timeout: 10_000 })
  if (res.status !== 0) return { ok: false, reason: res.stderr?.trim() || `exit ${res.status}` }
  return { ok: true, critical }
}