// Sinkronisasi engine dengan server landak.
//
// Jadwal kita dihitung dengan PrayTimes.js yang diambil dari server landak,
// lalu di-vendor sebagai file vanilla - bukan dependency npm. Alasannya: kalau
// ikut versi npm, angka jadwal bisa berubah sendiri tanpa ada yang bilang.

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Server landak hanya melayani TLS dengan DH key yang terlalu kecil untuk
// OpenSSL modern, jadi https gagal di Node. Pakai http polos, seperti yang
// dilakukan halaman itu sendiri, dan hash bandingkan supaya bisa dibuktikan.
export const SOURCE = "http://shalat.landak.com/PrayTimes.js"

const VENDOR = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "PrayTimes.js")

const sha256 = (text) => createHash("sha256").update(text).digest("hex")

/**
 * Bandingkan vendor lokal dengan yang ada di server.
 * - updated : file lokal diperbarui (server berubah dan kita sukses ambil)
 * - differs : server berubah tapi tidak bisa diambil
 * - current : sama persis
 */
export function syncVendor(log = () => {}, { timeoutMs = 45_000 } = {}) {
  const local = existsSync(VENDOR) ? readFileSync(VENDOR, "utf8") : null

  const res = spawnSync("curl", ["-sSfL", "--max-time", String(Math.round(timeoutMs / 1000)), SOURCE], {
    encoding: "utf8",
    timeout: timeoutMs,
  })

  if (res.status !== 0 || !res.stdout) {
    return {
      updated: false,
      differs: false,
      reason: res.stderr?.trim() || `curl exit ${res.status ?? res.signal}`,
    }
  }

  const remote = res.stdout
  if (local !== null && sha256(local) === sha256(remote)) {
    return { updated: false, differs: false, reason: "sama" }
  }

  writeFileSync(VENDOR, remote)
  return {
    updated: true,
    differs: local !== null,
    reason: local === null ? "vendor baru" : "server landak berubah",
    sha256: sha256(remote),
  }
}

export function vendorStatus() {
  if (!existsSync(VENDOR)) return { exists: false }
  const text = readFileSync(VENDOR, "utf8")
  return { exists: true, bytes: text.length, sha256: sha256(text) }
}