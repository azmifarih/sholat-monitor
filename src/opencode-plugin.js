// Pemasangan plugin TUI OpenCode: salin berkasnya, lalu daftarkan di cli.json.
//
// Dipisah dari bin/sholat supaya bisa diuji tanpa menjalankan systemctl.
//
// Aturan utamanya satu: `cli.json` berisi daftar plugin MILIK PENGGUNA. Jadi
// modul ini tidak boleh menimpa file yang tidak bisa dibaca, tidak boleh
// menambah entri yang sudah ada, dan harus mencadangkan sebelum mengubah.

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// Id yang dipakai di cli.json, relatif terhadap folder config OpenCode.
export const PLUGIN_ID = "./sholat-alert"

// Berkas yang harus ada supaya plugin bisa dimuat. package.json-lah yang
// mendeklarasikan exports "./tui", jadi tanpa itu OpenCode tidak menemukannya.
export const FILES = ["package.json", "tui.js"]

export function pluginPaths(home = homedir()) {
  const base = join(home, ".config", "opencode")
  return { dir: join(base, "sholat-alert"), cli: join(base, "cli.json") }
}

/**
 * Pasang plugin. Aman dijalankan berulang.
 * @returns {{ok: boolean, registered?: "baru"|"sudah"|false, notes: string[], reason?: string}}
 */
export function installTuiPlugin({ home = homedir(), srcDir } = {}) {
  const { dir, cli: cliPath } = pluginPaths(home)
  const notes = []

  for (const name of FILES) {
    const src = join(srcDir, name)
    if (!existsSync(src)) return { ok: false, notes, reason: `${src} tidak ada` }
  }

  mkdirSync(dir, { recursive: true })
  for (const name of FILES) copyFileSync(join(srcDir, name), join(dir, name))

  let cli = {}
  if (existsSync(cliPath)) {
    try {
      cli = JSON.parse(readFileSync(cliPath, "utf8"))
    } catch (error) {
      // JANGAN timpa. Bisa jadi file itu JSONC yang valid untuk OpenCode, dan
      // menghapus konfigurasi pengguna jauh lebih buruk daripada gagal jelas.
      return {
        ok: true,
        registered: false,
        notes: [
          `plugin disalin, tapi cli.json tidak bisa dibaca sebagai JSON (${error.message})`,
          `daftarkan manual: "plugins": [..., "${PLUGIN_ID}"]`,
        ],
      }
    }
  }

  const plugins = Array.isArray(cli.plugins) ? cli.plugins : []

  // Sudah terdaftar: jangan sentuh file, dan jangan bikin cadangan baru - kalau
  // tidak, tiap kali `install` dijalankan akan menumpuk file .bak.
  if (plugins.includes(PLUGIN_ID)) return { ok: true, registered: "sudah", notes }

  // Baru sekarang file benar-benar berubah, jadi baru sekarang dicadangkan.
  if (existsSync(cliPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const backup = `${cliPath}.bak-sholat-${stamp}`
    copyFileSync(cliPath, backup)
    notes.push(`cadangan cli.json: ${backup}`)
  }

  cli.plugins = [...plugins, PLUGIN_ID]
  writeFileSync(cliPath, JSON.stringify(cli, null, 2) + "\n")
  return { ok: true, registered: "baru", notes }
}

/** Apakah berkasnya lengkap DAN terdaftar? Keduanya perlu, satu saja tidak cukup. */
export function pluginStatus({ home = homedir() } = {}) {
  const { dir, cli: cliPath } = pluginPaths(home)
  const files = FILES.every((name) => existsSync(join(dir, name)))

  let registered = false
  if (existsSync(cliPath)) {
    try {
      registered = (JSON.parse(readFileSync(cliPath, "utf8")).plugins ?? []).includes(PLUGIN_ID)
    } catch {
      registered = false
    }
  }

  return { files, registered, dir, ok: files && registered }
}
