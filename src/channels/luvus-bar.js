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
import { luvusBin, failureReason } from "../luvus.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const PUBLISH = join(ROOT, "luvus-bar", "publish.js")

export function available() {
  return existsSync(PUBLISH)
}

export function luvusBar(cfg, _alert) {
  if (!cfg.enabled) return { ok: false, reason: "dimatikan di config" }

  // Sesi TIDAK diselesaikan di sini, melainkan di publish.js - satu tempat,
  // sekali tanya. Yang diwariskan cuma LUVUS_BIN_PATH supaya anak memakai
  // binary yang sama dengan yang sedang berjalan. Ini juga yang membuat hook
  // `[[startup]]` benar: hook itu dijalankan Luvus, bukan daemon, jadi publish.js
  // harus bisa menyelesaikan sesi sendiri.
  const res = spawnSync(process.execPath, [PUBLISH], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, LUVUS_BIN_PATH: luvusBin() },
  })
  // publish.js mencetak alasan kegagalannya ke stderr, jadi itu yang dipakai.
  if (res.status !== 0) return { ok: false, reason: failureReason(res) }
  return { ok: true }
}