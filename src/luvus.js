// Satu pintu untuk memanggil CLI `luvus`.
//
// Kenapa berkas ini ada: nama sesi Luvus tidak stabil, tapi dulu nama itu
// di-hardcode di unit systemd (`LUVUS_SESSION=probe`) dan di tiga tempat
// pemanggilan. Begitu sesi berganti nama, SELURUH channel Luvus mati - toast,
// notification center, bar, dan routing pane - sementara service tetap
// `active` dan `sholat doctor` tetap hijau. Jadi: nama sesi DISCOVER dari
// Luvus, bukan diasumsikan.
//
// Aturan pemilihan sesi yang dipakai berkas ini:
//
//   LUVUS_SESSION diset dan sesinya memang running   -> pakai itu (source "env")
//   LUVUS_SESSION diset tapi sesinya tidak running   -> cari sesi running (env-usang)
//   LUVUS_SESSION kosong / "auto"                     -> cari sesi running (ditemukan)
//   tidak ada sesi running sama sekali               -> biarkan gagal (tanpa-sesi)
//   `luvus session list` tidak bisa dibaca           -> pakai LUVUS_SESSION apa
//                                                       adanya (tidak-terbaca)
//
// "Eksplisit menang" disengaja: kalau seseorang menyetel LUVUS_SESSION dengan
// sadar, tebakan otomatis tidak boleh melawannya. Yang otomatis hanya dipakai
// ketika pilihan eksplisit itu sudah tidak ada lagi.

import { spawnSync } from "node:child_process"

// Sama seperti focus.js: CLI Luvus lokal harus menjawab cepat. Kalau lebih dari
// ini, Luvus dianggap tidak bisa dihubungi dan daemon tidak perlu menunggu.
const LIST_TIMEOUT_MS = 4_000

// Penanda khusus untuk "jangan pakai nama dari environment, cari sendiri".
// Dipakai kalau seseorang ingin pemilihan sepenuhnya otomatis.
export const AUTO = "auto"

/**
 * Binary `luvus` yang dipakai.
 *
 * LUVUS_BIN_PATH menang karena itu binary yang sedang menjalankan kita - tetap
 * benar walau ada versi lain di PATH atau socket named-pipe.
 */
export function luvusBin() {
  return process.env.LUVUS_BIN_PATH ?? "luvus"
}

/**
 * Daftar sesi Luvus, atau `null` kalau daftarnya tidak terbaca.
 *
 * `null` sengaja dibedakan dari `[]`: "tidak bisa dibaca" berarti kita tidak
 * berhak menyimpulkan apa pun, sedangkan "kosong" berarti benar-benar tidak ada
 * sesi. Menyamakan keduanya akan membuat daemon memilih `null` padahal ada sesi
 * yang bisa dipakai.
 */
export function listSessions(opts = {}) {
  const res = spawnSync(opts.bin ?? luvusBin(), ["session", "list", "--json"], {
    encoding: "utf8",
    timeout: opts.timeout ?? LIST_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (res.status !== 0) return null
  try {
    const parsed = JSON.parse(res.stdout)
    return Array.isArray(parsed?.sessions) ? parsed.sessions : null
  } catch {
    return null
  }
}

/**
 * Pilih sesi yang harus ditarget.
 *
 * @returns {{ bin: string, session: string|null, source: string, running: string[] }}
 *   `source` menjelaskan dari mana nama itu datang, supaya kegagalan bisa
 *   didiagnosis tanpa menebak. Nilainya: env, env-usang, ditemukan, tanpa-sesi,
 *   tidak-terbaca.
 */
export function resolveLuvus(opts = {}) {
  const bin = opts.bin ?? luvusBin()
  const raw = String(opts.explicit ?? process.env.LUVUS_SESSION ?? "").trim()
  const explicit = raw && raw !== AUTO ? raw : null

  // `sessions` yang disuntikkan boleh null (meniru "tidak terbaca"); karena itu
  // pemeriksaannya `!== undefined`, bukan `??`.
  const sessions = opts.sessions !== undefined ? opts.sessions : listSessions({ bin, timeout: opts.timeout })

  if (!Array.isArray(sessions)) return { bin, session: explicit, source: "tidak-terbaca", running: [] }

  const running = sessions.filter((s) => s?.running && s?.name)
  if (explicit && running.some((s) => s.name === explicit)) {
    return { bin, session: explicit, source: "env", running: running.map((s) => s.name) }
  }

  if (running.length === 0) return { bin, session: explicit, source: "tanpa-sesi", running: [] }

  // Sesi default didahulukan, lalu urutan daftar. Deterministik: dua tick
  // berturut-turut tidak boleh mengirim ke sesi yang berbeda.
  const picked = (running.find((s) => s.default) ?? running[0]).name
  return { bin, session: picked, source: explicit ? "env-usang" : "ditemukan", running: running.map((s) => s.name) }
}

/**
 * Jalankan CLI luvus dengan sesi yang sudah benar.
 *
 * Semua pemanggil harus lewat sini. Itu intinya: satu tempat yang mengurus
 * PATH dan sesi, supaya tidak ada lagi pemanggil yang lupa - bentuk bug yang
 * berkas ini tutup.
 */
export function runLuvus(args, opts = {}) {
  const { bin, session } = resolveLuvus(opts)
  const env = { ...process.env }
  if (session) env.LUVUS_SESSION = session
  else delete env.LUVUS_SESSION

  return spawnSync(bin, args, {
    encoding: "utf8",
    timeout: opts.timeout ?? 10_000,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  })
}

/**
 * Terjemahkan hasil spawnSync jadi alasan yang bisa dibaca manusia.
 *
 * Ini bagian yang paling penting untuk debugging. `exit null` berarti
 * spawnSync mendapat `error`, dan penyebab yang paling sering adalah ENOENT -
 * prosesnya TIDAK PERNAH JALAN. Dulu itu terbaca seperti "prosesnya jalan lalu
 * menolak", dan salah baca itulah yang membuat bug PATH tidak ketahuan
 * berhari-hari. Sekarang ENOENT menyebut binary dan PATH-nya sekalian.
 */
export function failureReason(res, opts = {}) {
  if (res?.error?.code === "ENOENT") {
    const bin = res.error.path ?? opts.bin ?? luvusBin()
    return `tidak ketemu: ${bin} (PATH=${process.env.PATH ?? "-"})`
  }
  if (res?.error) return `gagal dijalankan: ${res.error.code ?? res.error.message}`
  const stderr = res?.stderr?.trim()
  if (stderr) return stderr
  if (res?.signal) return `terbunuh signal ${res.signal}`
  return `exit ${res?.status}`
}
