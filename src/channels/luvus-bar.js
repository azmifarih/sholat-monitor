// Channel Luvus Bar: repaint widget "Waktu Sholat" di bar Luvus.
//
// Widget-nya dideklarasikan oleh module `sholat.bar` yang sudah terpasang
// (`luvus module link`). Module itu cuma menulis lewat `luvus bar push`, jadi
// daemon cukup memanggil skrip publish-nya. Sekali push = seluruh konten widget
// diganti, jadi aman dipanggil tiap menit.

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const PUBLISH = join(ROOT, "luvus-bar", "publish.js")

export function available() {
  return existsSync(PUBLISH)
}

export function luvusBar(cfg, _alert) {
  if (!cfg.enabled) return { ok: false, reason: "dimatikan di config" }

  // Sengaja pakai LUVUS_BIN_PATH kalau ada: itu binary yang sedang berjalan,
  // jadi tetap benar walau ada versi lain di PATH atau socket named-pipe.
  const luvus = process.env.LUVUS_BIN_PATH ?? "luvus"
  const res = spawnSync(process.execPath, [PUBLISH], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, LUVUS_BIN_PATH: luvus },
  })
  if (res.status !== 0) return { ok: false, reason: res.stderr?.trim() || `exit ${res.status}` }
  return { ok: true }
}