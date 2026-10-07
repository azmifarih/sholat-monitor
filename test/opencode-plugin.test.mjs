// Tes pemasangan plugin TUI OpenCode.
//
// Yang paling penting diuji: modul ini menyentuh cli.json MILIK PENGGUNA, jadi
// kesalahannya bukan "plugin tidak jalan" tapi "konfigurasi orang hilang".
//
//   node --test test/

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { installTuiPlugin, pluginStatus, pluginPaths, PLUGIN_ID, FILES } = await import("../src/opencode-plugin.js")

const ROOT = new URL("..", import.meta.url).pathname
const SRC = join(ROOT, "opencode-tui")

/** HOME palsu dengan cli.json berisi plugin lain milik pengguna. */
function fakeHome(cliJson) {
  const home = mkdtempSync(join(tmpdir(), "sholat-plugin-"))
  mkdirSync(join(home, ".config", "opencode"), { recursive: true })
  if (cliJson !== undefined) {
    writeFileSync(join(home, ".config", "opencode", "cli.json"), typeof cliJson === "string" ? cliJson : JSON.stringify(cliJson, null, 2) + "\n")
  }
  return home
}

const backups = (home) => readdirSync(join(home, ".config", "opencode")).filter((n) => n.includes("bak-sholat"))
const cliOf = (home) => JSON.parse(readFileSync(pluginPaths(home).cli, "utf8"))

test("install menambah plugin tanpa merusak plugin atau key lain", () => {
  const home = fakeHome({ plugins: ["./luvus-v2", "./usage-footer"], model: "x/y" })
  try {
    const result = installTuiPlugin({ home, srcDir: SRC })
    assert.equal(result.ok, true)
    assert.equal(result.registered, "baru")

    const cli = cliOf(home)
    assert.deepEqual(cli.plugins, ["./luvus-v2", "./usage-footer", PLUGIN_ID])
    assert.equal(cli.model, "x/y", "key lain tidak boleh hilang")

    // Berkasnya benar-benar tersalin, dan identik dengan sumbernya.
    for (const name of FILES) {
      assert.ok(existsSync(join(pluginPaths(home).dir, name)), `${name} harus tersalin`)
      assert.equal(
        readFileSync(join(pluginPaths(home).dir, name), "utf8"),
        readFileSync(join(SRC, name), "utf8"),
        `${name} harus identik dengan sumber`,
      )
    }
    assert.equal(backups(home).length, 1, "file yang diubah harus dicadangkan sekali")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("install aman dijalankan berulang", () => {
  const home = fakeHome({ plugins: [PLUGIN_ID] })
  try {
    const before = readFileSync(pluginPaths(home).cli, "utf8")
    const result = installTuiPlugin({ home, srcDir: SRC })
    assert.equal(result.registered, "sudah")
    assert.equal(readFileSync(pluginPaths(home).cli, "utf8"), before, "file tidak boleh disentuh")
    assert.equal(backups(home).length, 0, "tidak boleh menumpuk cadangan")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("cli.json yang tidak bisa dibaca TIDAK ditimpa", () => {
  // JSONC (berkomentar) valid untuk OpenCode tapi bukan JSON. Menimpanya akan
  // menghapus konfigurasi pengguna, jadi modul ini harus menolak dengan sopan.
  const raw = '{\n  // komentar\n  "plugins": ["./luvus-v2"]\n}\n'
  const home = fakeHome(raw)
  try {
    const result = installTuiPlugin({ home, srcDir: SRC })
    assert.equal(result.ok, true, "berkas plugin tetap dipasang")
    assert.equal(result.registered, false, "tapi tidak didaftarkan")
    assert.equal(readFileSync(pluginPaths(home).cli, "utf8"), raw, "isi file harus utuh")
    assert.equal(backups(home).length, 0)
    assert.ok(result.notes.some((n) => n.includes("daftarkan manual")), "harus memberi cara manual")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("cli.json yang belum ada dibuatkan", () => {
  const home = fakeHome(undefined)
  try {
    const result = installTuiPlugin({ home, srcDir: SRC })
    assert.equal(result.registered, "baru")
    assert.deepEqual(cliOf(home).plugins, [PLUGIN_ID])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("cli.json tanpa key plugins tetap ditangani", () => {
  const home = fakeHome({ theme: "gelap" })
  try {
    installTuiPlugin({ home, srcDir: SRC })
    const cli = cliOf(home)
    assert.deepEqual(cli.plugins, [PLUGIN_ID])
    assert.equal(cli.theme, "gelap")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("sumber tidak lengkap dilaporkan, bukan gagal diam-diam", () => {
  const home = fakeHome({ plugins: [] })
  const kosong = mkdtempSync(join(tmpdir(), "sholat-src-"))
  try {
    const result = installTuiPlugin({ home, srcDir: kosong })
    assert.equal(result.ok, false)
    assert.match(result.reason, /tidak ada/)
    assert.equal(backups(home).length, 0, "tidak boleh mengubah cli.json")
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(kosong, { recursive: true, force: true })
  }
})

test("pluginStatus membedakan berkas dan pendaftaran", () => {
  const home = fakeHome({ plugins: [] })
  try {
    // Belum ada apa-apa.
    const kosong = pluginStatus({ home })
    assert.equal(kosong.files, false)
    assert.equal(kosong.registered, false)
    assert.equal(kosong.ok, false)

    // Berkas ada tapi belum terdaftar -> belum ok.
    mkdirSync(pluginPaths(home).dir, { recursive: true })
    for (const name of FILES) copyFileSync(join(SRC, name), join(pluginPaths(home).dir, name))
    assert.equal(pluginStatus({ home }).files, true)
    assert.equal(pluginStatus({ home }).registered, false)
    assert.equal(pluginStatus({ home }).ok, false, "berkas saja tidak cukup")

    // Setelah didaftarkan -> ok.
    installTuiPlugin({ home, srcDir: SRC })
    assert.equal(pluginStatus({ home }).ok, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
