// Channel suara: adhan dari server landak yang sama dengan sumber jadwal.
//
// Matikan secara bawaan (channels.sound.enabled = false) karena suara adalah
// satu-satunya channel yang benar-benar merebut perhatian - itu bagus saat kamu
// sedang di meja, buruk kalau jam 4 pagi. Karena itu ada channels.quiet.

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"

const STATE_DIR = join(homedir(), ".local", "state", "sholat-monitor")

function expand(path) {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path
}

/** Unduh adhan sekali lalu pakai cache. Server landak hanya melayani HTTP polos. */
export function ensureAudio(cfg, log = () => {}) {
  const file = expand(cfg.file)
  if (existsSync(file) && statSync(file).size > 10_000) return file

  mkdirSync(STATE_DIR, { recursive: true })
  log(`mengunduh adhan dari ${cfg.url}`)
  const res = spawnSync("curl", ["-sSfL", "--max-time", "90", "-o", file, cfg.url], {
    encoding: "utf8",
    timeout: 100_000,
  })
  if (res.status !== 0) {
    log(`gagal mengunduh adhan: ${res.stderr?.trim() || `exit ${res.status}`}`)
    return null
  }
  if (!existsSync(file) || statSync(file).size <= 10_000) {
    log("berkas adhan terlalu kecil, dianggap gagal")
    return null
  }
  return file
}

function pickPlayer(cfg) {
  if (cfg.player !== "auto") return cfg.player
  for (const bin of ["ffplay", "paplay", "mpv", "cvlc"]) {
    const r = spawnSync("command", ["-v", bin], { shell: true })
    if (r.status === 0) return bin
  }
  return null
}

export function available() {
  return true
}

export function sound(cfg, _alert, log = () => {}) {
  if (!cfg.enabled) return { ok: false, reason: "dimatikan di config" }

  const file = ensureAudio(cfg, log)
  if (!file) return { ok: false, reason: "adhan tidak tersedia" }

  const player = pickPlayer(cfg)
  if (!player) return { ok: false, reason: "tidak ada ffplay/paplay/mpv/cvlc" }

  const volume = String(Math.max(0, Math.min(100, cfg.volume)) / 100)
  const args = {
    ffplay: ["-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", volume, file],
    paplay: ["--volume=" + Math.round((cfg.volume / 100) * 65536), file],
    mpv: ["--no-video", "--really-quiet", `--volume=${cfg.volume}`, file],
    cvlc: ["--play-and-exit", "--intf", "dummy", `--gain=${volume}`, file],
  }[player]

  // Detach: suara harus tetap bunyi meski daemon langsung lanjut ke tick berikutnya.
  const res = spawnSync("sh", ["-c", 'exec "$1" "$2" >/dev/null 2>&1', "sh", player, ...args], {
    timeout: 5_000,
    detached: true,
    stdio: "ignore",
  })
  if (res.error) return { ok: false, reason: res.error.message }
  return { ok: true, player }
}