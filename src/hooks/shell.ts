// Best-effort reading of a Bash command: enough to find which directory each
// part of a chain runs in and what it does. Not a shell parser; every caller
// treats "could not tell" as the strict answer.

export type Segment = {
  /** The segment as written, heredoc bodies it opened appended. */
  text: string
  /** Same text with quoted content and heredoc bodies blanked out. */
  masked: string
  /** The segment as written, without heredoc bodies. */
  head: string
  /** Heredoc bodies this segment opened. */
  bodies: string[]
  /** Directory the segment runs in; null once a `cd` could not be resolved. */
  dir: string | null
}

const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n([\s\S]*?)\n\s*\2(?=\n|$)/g

/** Removes heredoc bodies, returning the command without them and each body. */
export function splitHeredocs(command: string): { rest: string; bodies: { at: number; body: string }[] } {
  const bodies: { at: number; body: string }[] = []
  let rest = ''
  let last = 0
  for (const m of command.matchAll(HEREDOC)) {
    const index = m.index ?? 0
    const head = m[0].slice(0, m[0].indexOf('\n'))
    rest += command.slice(last, index) + head
    bodies.push({ at: rest.length, body: m[3] ?? '' })
    last = index + m[0].length
  }
  rest += command.slice(last)
  return { rest, bodies }
}

/** Blanks the inside of '…' and "…" so operators inside strings are ignored. */
export function maskQuotes(s: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < s.length) {
        out += '__'
        i++
        continue
      }
      if (c === quote) {
        quote = null
        out += c
      } else out += '_'
      continue
    }
    if (c === '"' || c === "'") quote = c
    out += c
  }
  return out
}

export function unquote(word: string): string {
  const t = word.trim()
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) return t.slice(1, -1)
  return t.replace(/\\ /g, ' ')
}

export function normalize(path: string): string {
  const parts: string[] = []
  for (const p of path.split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  return '/' + parts.join('/')
}

export function resolvePath(base: string, p: string, home: string): string {
  if (p === '~') return normalize(home)
  if (p.startsWith('~/')) return normalize(home + p.slice(1))
  if (p.startsWith('/')) return normalize(p)
  return normalize(base + '/' + p)
}

export function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : root + '/')
}

/** First word after `cmd` in a masked segment, read from the original text. */
function argAfter(text: string, masked: string, re: RegExp): string | undefined {
  const m = re.exec(masked)
  if (!m) return undefined
  const start = (m.index ?? 0) + m[0].length
  const tail = text.slice(start)
  const tm = maskQuotes(tail)
  const end = tm.search(/[\s;&|)]/)
  const word = end === -1 ? tail : tail.slice(0, end)
  return word === '' ? undefined : unquote(word)
}

/**
 * Splits a command on `&&`, `||`, `;`, `|` and newlines (outside quotes) and
 * tracks the directory through `cd`/`pushd`. A `cd` whose target holds a
 * variable or substitution makes every later directory unknown.
 */
export function segments(command: string, cwd: string | null, home: string): Segment[] {
  const { rest, bodies } = splitHeredocs(command)
  const masked = maskQuotes(rest)
  const out: Segment[] = []
  let dir: string | null = cwd
  let start = 0
  const push = (end: number) => {
    const text0 = rest.slice(start, end)
    const m = masked.slice(start, end)
    const own = bodies.filter(b => b.at > start && b.at <= end).map(b => b.body)
    if (text0.trim() !== '') {
      const cdArg = /^\s*\(?\s*(?:cd|pushd)(?=\s|$)/.test(m) ? argAfter(text0, m, /^\s*\(?\s*(?:cd|pushd)\s+/) : null
      if (cdArg !== null) {
        if (cdArg === undefined) dir = home
        else if (/[$`]/.test(cdArg)) dir = null
        else if (dir !== null) dir = resolvePath(dir, cdArg, home)
      }
      out.push({ text: [text0, ...own].join('\n'), head: text0, bodies: own, masked: m, dir })
    }
    start = end
  }
  const re = /&&|\|\||[;|\n]/g
  for (const m of masked.matchAll(re)) {
    push(m.index ?? 0)
    start = (m.index ?? 0) + m[0].length
  }
  push(rest.length)
  return out
}

/** Path-like words in a segment: quoted strings and words with a slash or an extension. */
export function pathTokens(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/"([^"\n]+)"|'([^'\n]+)'|(?<=^|[\s=(<>])([^\s"'|&;<>()]+)/g)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? ''
    if (raw === '' || raw.startsWith('-') || raw.includes('://') || raw.includes('$')) continue
    if (raw.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(raw) || raw.startsWith('~')) out.push(raw)
  }
  return out
}

/** Contents of the quoted strings in `text` ("…" with \-escapes undone, '…' as is). */
export function quotedStrings(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) {
    out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? ''))
  }
  return out
}

// Adapted from Felix's MIT boundaries rules: wrappers, cwd tracking and unknown
// repository handling are retained; unrelated rules are omitted.
function word(raw: string): string {
  return [...raw.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)|([^'"\\]+)/g)].map(m => m[1] ?? (m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3] ?? m[4])).join("");
}
/** Redirections are not arguments: `2>&1` and `> out` must never be read as refs. */
function dropRedirections(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const m = /^(?:\d*|&)(?:>>?|<)(&?)(.*)$/.exec(words[i]);
    if (!m) { out.push(words[i]); continue; }
    if (m[2] === "") i++; // `> file`: the target is the next word
  }
  return out;
}
export interface ShellAction { kind: "merge" | "branch" | "deploy" | "human"; dir: string | null; refs: string[]; words: string[]; pr?: string; unknownOption?: string }
export function classifyShell(command: string, cwd: string | null, home = process.env.HOME ?? "/", depth = 0): ShellAction[] {
  const out: ShellAction[] = [];
  // Visible substitutions execute even in a non-shell wrapper such as echo.
  // Ambiguous quoting is conservative; never evaluate substitutions ourselves.
  for (const match of command.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)) {
    if (depth < 3) out.push(...classifyShell(match[1] ?? match[2], null, home, depth + 1));
    else if (/\b(?:git|gh|xt)\b/.test(match[0])) out.push({ kind: "merge", dir: null, refs: [], words: [] });
  }
  const elsewhere = /\bGIT_DIR=|\bGIT_WORK_TREE=|--git-dir\b|--work-tree\b/.test(command);
  for (const seg of segments(command, cwd, home)) {
    // Bash joins adjacent quoted parts and drops backslashes, so `g"i"t me\rge` is `git merge`.
    const words = dropRedirections((seg.head.match(/(?:[^\s"'\\]+|\\.|"[^"]*"|'[^']*')+/g) ?? []).map(word));
    let dir = seg.dir;
    if (elsewhere || /\bGIT_DIR=|\bGIT_WORK_TREE=|--git-dir\b|--work-tree\b|[$`()]/.test(seg.head)) dir = null;
    const gi = words.findIndex(w => /^(?:.*\/)?git$/.test(w));
    if (gi >= 0) {
      let i = gi + 1;
      while (words[i]?.startsWith("-")) {
        if (words[i] === "-C") { const p = words[++i]; dir = dir && p ? resolvePath(dir, p, home) : null; }
        else if (words[i] === "-c") { i++; dir = null; }
        else dir = null;
        i++;
      }
      const op = words[i++], args = words.slice(i);
      if (["merge", "rebase", "cherry-pick", "revert"].includes(op) &&
          args.length === 1 && ["--abort", "--continue", "--skip", "--quit", ...(op === "rebase" ? ["--edit-todo"] : [])].includes(args[0])) continue;
      if (["merge", "pull", "rebase", "cherry-pick"].includes(op)) {
        const refs: string[] = [];
        let unknownOption: string | undefined;
        const flags = ["--no-ff", "--ff", "--ff-only", "--squash", "--no-edit", "--no-verify", "-q", "--stat", "--no-stat", ...(op === "pull" ? ["--rebase", "-r", "--no-rebase"] : [])];
        for (let j = 0; j < args.length; j++) {
          const arg = args[j];
          if (arg === "--") { refs.push(...args.slice(j + 1)); break; }
          if (op === "merge" && ["-m", "--message", "-s", "-X"].includes(arg)) {
            if (!args[++j]) unknownOption = arg;
          } else if (op === "merge" && /^(?:--message=|-[mXs].)/.test(arg)) continue;
          else if (arg.startsWith("-") && !flags.includes(arg)) unknownOption ??= arg.match(/^--[a-zA-Z0-9-]+/)?.[0] ?? arg.slice(0, 2);
          else if (!arg.startsWith("-")) refs.push(arg);
        }
        if (unknownOption) dir = null;
        out.push({ kind: "merge", dir, unknownOption, refs: op === "pull" ? (refs.length === 2 ? [refs.join("/")] : []) : refs, words });
      }
      if (op === "worktree" && args[0] === "add") {
        const create = args.findIndex(w => /^-[bB]/.test(w));
        if (create >= 0) {
          const tail = args.slice(1).filter((_, n) => n + 1 !== create && !(args[create].length === 2 && n + 1 === create + 1)).filter(w => !w.startsWith("-"));
          out.push({ kind: "branch", dir, refs: [tail[1] ?? "HEAD"], words });
        }
      }
      const branchCreate = op === "branch" && args.some(w => !w.startsWith("-")) && !args.some(w => /^(?:--(?:list|delete|move|show-current|edit-description|set-upstream-to|unset-upstream|contains|merged|no-merged|all|remotes)|-[dDmMvar]+)(?:=|$)/.test(w));
      // Attached values (`-bnew`, `--create=new`) consume the new name; the start point follows.
      const create = op === "switch" ? args.findIndex(w => /^(?:-[cC]|--(?:force-)?create)(?:=|$)/.test(w) || /^-[cC]./.test(w)) : op === "checkout" ? args.findIndex(w => /^-[bB]/.test(w)) : -1;
      if (create >= 0 || branchCreate) {
        const flag = args[create] ?? "", attached = create >= 0 && (flag.includes("=") || /^-[a-zA-Z]./.test(flag));
        const refs = args.filter(w => !w.startsWith("-")).slice(attached ? 0 : 1);
        out.push({ kind: "branch", dir, refs: [refs[0] ?? "HEAD"], words });
      }
    }
    const gh = words.findIndex(w => /^(?:.*\/)?gh$/.test(w));
    if (gh >= 0 && words[gh + 1] === "pr" && words[gh + 2] === "merge") {
      const args = words.slice(gh + 3);
      if (args.some(w => w.startsWith("-") && !["--merge", "--squash", "--rebase", "--auto", "--delete-branch"].includes(w))) dir = null;
      out.push({ kind: "merge", dir, refs: [], words, pr: args.find(w => !w.startsWith("-")) ?? "" });
    }
    const xi = words.findIndex(w => /^(?:.*\/)?xt$/.test(w));
    if (xi >= 0) {
      const [op, sub] = words.slice(xi + 1);
      if (["answer", "override", "trust", "enroll", "admin"].includes(op) || (op === "hook" && sub === "git" && words[xi + 3] === "seed") || (op === "ask" && sub === "withdraw" && words.slice(xi + 2).includes("--human")) || (op === "release" && words.slice(xi + 2).includes("--human")) || (op === "env" && sub === "adopt") || (op === "executor" && ["enroll", "reconcile"].includes(sub))) out.push({ kind: "human", dir, refs: [], words });
      if (op === "executor" && sub === "promote") out.push({ kind: "deploy", dir, refs: [], words: words.slice(xi + 3) });
    }
    if (/(?:^|[\s(])(?:\S*\/)?(?:ssh|mosh|bash|sh|zsh|eval|xargs)(?=\s|$)/.test(seg.masked)) {
      for (const inner of [...quotedStrings(seg.head), ...seg.bodies]) {
        if (depth < 3) out.push(...classifyShell(inner, /\b(?:ssh|mosh)\b/.test(seg.masked) ? null : dir, home, depth + 1));
        else if (/\b(?:git|gh|xt)\b/.test(inner)) out.push({ kind: "merge", dir: null, refs: [], words: [] });
      }
    }
  }
  return out;
}
