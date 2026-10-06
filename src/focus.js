// Siapa yang harus diberi tahu: cari pane Luvus yang sedang fokus.
//
// Daemon tidak tahu apa pun tentang fokus - itu urusan Luvus. Yang kita lakukan
// hanya menanyakan "pane mana yang sedang fokus?", lalu menuliskan jawabannya ke
// alert.json. Plugin TUI OpenCode membandingkan id itu dengan LUVUS_PANE_ID
// miliknya sendiri, jadi hanya TUI yang sedang dilihat yang berteriak.

import { execFileSync } from "node:child_process"

const LUVUS = process.env.LUVUS_BIN_PATH ?? "luvus"
const LUVUS_TIMEOUT_MS = 4_000

/** @returns {{ pane: string|null, agent: string|null, status: string|null, source: string }} */
export function focusedPane(opts = {}) {
  const agent = opts.agent ?? "opencode"
  try {
    const raw = execFileSync(LUVUS, ["pane", "list"], {
      encoding: "utf8",
      timeout: LUVUS_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const parsed = JSON.parse(raw)
    const rows = Array.isArray(parsed?.result) ? parsed.result : (parsed?.result?.panes ?? [])
    if (rows.length === 0) return { pane: null, agent: null, status: null, source: "empty" }

    const focused = rows.find((p) => p.focused)
    if (!focused) return { pane: null, agent: null, status: null, source: "no-focus" }

    // Kalau pane yang fokus bukan opencode, cari opencode di tab yang sama -
    // itu masih "jendela" yang sedang dilihat pengguna.
    let target = focused
    if (focused.agent !== agent) {
      target = rows.find((p) => p.agent === agent && p.tab === focused.tab) ?? focused
    }
    return {
      pane: target.pane ?? null,
      agent: target.agent ?? null,
      status: target.status ?? null,
      source: target === focused ? "focused" : "focused-tab-sibling",
    }
  } catch (error) {
    return { pane: null, agent: null, status: null, source: `error: ${error.code ?? error.message}` }
  }
}

/** Alert tanpa targeting: dipakai kalau Luvus tidak bisa dihubungi. */
export const UNTARGETED = { pane: undefined, source: "untargeted" }