// Channel OpenCode: tulis alert.json yang dibaca plugin TUI OpenCode.
//
// Daemon tidak tahu terminal mana yang sedang dilihat. Luvus tahu, jadi
// daemon bertanya ke Luvus lalu menuliskan jawabannya; plugin TUI membandingkan
// id itu dengan LUVUS_PANE_ID miliknya sendiri. Kalau Luvus tidak bisa
// dihubungi, alert tetap ditulis tanpa target - semua TUI akan menampilkannya.

import { writeFileSync, mkdirSync, renameSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { focusedPane } from "../focus.js"

export const STATE_DIR = process.env.SHOLAT_STATE_DIR
  ? process.env.SHOLAT_STATE_DIR.replace(/^~(?=$|\/)/, homedir())
  : join(homedir(), ".local", "state", "sholat-monitor")
export const ALERT_FILE = join(STATE_DIR, "alert.json")

export function available() {
  return true
}

/**
 * Tulis alert secara atomik (tulis sementara lalu rename) supaya plugin tidak
 * pernah membaca file setengah jadi.
 */
export function opencode(cfg, alert) {
  if (!cfg.enabled) return { ok: false, reason: "dimatikan di config" }

  const payload = {
    id: alert.id,
    level: alert.level,
    title: alert.title,
    message: alert.body,
    duration: alert.durationMs ?? 20_000,
    desktop: false, // desktop sudah ditangani daemon, jangan dua kali
    critical: alert.critical,
    sound: false,
    ...(alert.pane ? { pane: String(alert.pane) } : {}),
  }

  let target = null
  if (cfg.targetFocusedPane) {
    const focus = focusedPane()
    if (focus.pane) {
      target = focus.pane
      payload.pane = String(focus.pane)
    }
  }

  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const tmp = `${ALERT_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n")
    renameSync(tmp, ALERT_FILE)
    return { ok: true, pane: target }
  } catch (error) {
    return { ok: false, reason: error.message }
  }
}