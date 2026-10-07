// Tes pemilihan sesi Luvus (src/luvus.js).
//
// Sengaja tanpa Luvus sungguhan: semua daftar sesi disuntikkan. Yang diuji di
// sini adalah ATURAN pemilihan - bagian yang dulu menyebabkan channel Luvus
// mati diam-diam karena nama sesi di-hardcode.
//
//   node --test "test/*.mjs"

import { test } from "node:test"
import assert from "node:assert/strict"

const { resolveLuvus, runLuvus, failureReason, AUTO, luvusBin } = await import("../src/luvus.js")

const s = (name, running, isDefault = false) => ({ name, running, default: isDefault })

// --------------------------------------------------------------- pemilihan

test("LUVUS_SESSION dipakai kalau sesinya memang running", () => {
  const r = resolveLuvus({ explicit: "probe", sessions: [s("default", false, true), s("probe", true)] })
  assert.equal(r.session, "probe")
  assert.equal(r.source, "env")
  assert.deepEqual(r.running, ["probe"])
})

test("LUVUS_SESSION usang: daemon pindah ke sesi running sendiri", () => {
  // Ini kasus yang dulu mematikan seluruh channel Luvus.
  const r = resolveLuvus({ explicit: "probe", sessions: [s("default", false, true), s("kerja", true)] })
  assert.equal(r.session, "kerja")
  assert.equal(r.source, "env-usang")
})

test("tanpa LUVUS_SESSION: sesi running ditemukan sendiri", () => {
  const r = resolveLuvus({ explicit: "", sessions: [s("default", false, true), s("probe", true)] })
  assert.equal(r.session, "probe")
  assert.equal(r.source, "ditemukan")
})

test('LUVUS_SESSION="auto": selalu cari sendiri, walau env menunjuk sesi yang hidup', () => {
  const r = resolveLuvus({ explicit: AUTO, sessions: [s("probe", true), s("kerja", true)] })
  assert.equal(r.session, "probe")
  assert.equal(r.source, "ditemukan")
})

test('LUVUS_SESSION="auto" tidak memakai nama "auto" sebagai sesi', () => {
  const r = resolveLuvus({ explicit: "auto", sessions: [s("probe", true)] })
  assert.notEqual(r.session, "auto")
})

test("tidak ada sesi running: biarkan pilihan eksplisit lewat supaya error aslinya dari luvus", () => {
  const r = resolveLuvus({ explicit: "probe", sessions: [s("default", false, true), s("probe", false)] })
  assert.equal(r.session, "probe")
  assert.equal(r.source, "tanpa-sesi")
})

test("tidak ada sesi running dan tanpa env: tidak menebak", () => {
  const r = resolveLuvus({ explicit: "", sessions: [s("default", false, true)] })
  assert.equal(r.session, null)
  assert.equal(r.source, "tanpa-sesi")
})

test("daftar sesi tidak terbaca: LUVUS_SESSION dipakai apa adanya, bukan diganti null", () => {
  const r = resolveLuvus({ explicit: "probe", sessions: null })
  assert.equal(r.session, "probe")
  assert.equal(r.source, "tidak-terbaca")
})

test("beberapa sesi hidup dan tidak ada yang eksplisit: sesi default didahulukan", () => {
  const r = resolveLuvus({ explicit: "", sessions: [s("a", true), s("b", true, true)] })
  assert.equal(r.session, "b")
  assert.equal(r.source, "ditemukan")
})

test("beberapa sesi hidup tanpa default: urutan daftar dipakai, jadi deterministik", () => {
  const r1 = resolveLuvus({ explicit: "", sessions: [s("a", true), s("b", true)] })
  const r2 = resolveLuvus({ explicit: "", sessions: [s("a", true), s("b", true)] })
  assert.equal(r1.session, "a")
  assert.equal(r1.session, r2.session)
})

test("sesi tanpa nama diabaikan, bukan dipilih jadi null", () => {
  const r = resolveLuvus({ explicit: "", sessions: [{ running: true }, s("probe", true)] })
  assert.equal(r.session, "probe")
})

test("spasi di LUVUS_SESSION tidak dianggap nama sesi", () => {
  const r = resolveLuvus({ explicit: "   ", sessions: [s("probe", true)] })
  assert.equal(r.session, "probe")
  assert.equal(r.source, "ditemukan")
})

test("luvusBin menghormati LUVUS_BIN_PATH", () => {
  const before = process.env.LUVUS_BIN_PATH
  process.env.LUVUS_BIN_PATH = "/opt/luvus"
  try {
    assert.equal(luvusBin(), "/opt/luvus")
  } finally {
    if (before === undefined) delete process.env.LUVUS_BIN_PATH
    else process.env.LUVUS_BIN_PATH = before
  }
})

// ------------------------------------------------------------------ runLuvus

const PRINT_SESSION = ["-e", "process.stdout.write(process.env.LUVUS_SESSION ?? 'KOSONG')"]

test("runLuvus menyerahkan sesi hasil pemilihan ke proses anak", () => {
  const res = runLuvus(PRINT_SESSION, { bin: process.execPath, explicit: "usang", sessions: [s("kerja", true)] })
  assert.equal(res.status, 0)
  assert.equal(res.stdout, "kerja")
})

test("runLuvus membuang LUVUS_SESSION usang kalau tidak ada sesi yang bisa dipakai", () => {
  // Kalau nama lama diwariskan, luvus menargetkan sesi mati dan gagal - padahal
  // tanpa nama itu luvus bisa jatuh ke default-nya sendiri.
  const before = process.env.LUVUS_SESSION
  process.env.LUVUS_SESSION = "sudah-mati"
  try {
    const res = runLuvus(PRINT_SESSION, { bin: process.execPath, explicit: "", sessions: [s("default", false, true)] })
    assert.equal(res.status, 0)
    assert.equal(res.stdout, "KOSONG")
  } finally {
    if (before === undefined) delete process.env.LUVUS_SESSION
    else process.env.LUVUS_SESSION = before
  }
})

// ------------------------------------------------------- terjemahan kegagalan

test("ENOENT: alasan menyebut binary dan PATH, bukan 'exit null'", () => {
  const reason = failureReason({ error: { code: "ENOENT", path: "/home/u/.local/bin/luvus" } })
  assert.match(reason, /\/home\/u\/\.local\/bin\/luvus/)
  assert.match(reason, /PATH=/)
  assert.doesNotMatch(reason, /exit null/)
})

test("stderr dipakai kalau ada", () => {
  assert.equal(failureReason({ status: 1, stderr: "  not running  " }), "not running")
})

test("status null tanpa error pun tidak dilaporkan sebagai 'exit null'", () => {
  assert.match(failureReason({ status: null }), /exit null/)
  assert.match(failureReason({ status: null, signal: "SIGKILL" }), /SIGKILL/)
  assert.match(failureReason({ status: null, error: { code: "EACCES" } }), /EACCES/)
})
