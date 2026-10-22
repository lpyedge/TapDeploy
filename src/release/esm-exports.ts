// minimal, fail-closed ESM export scanner for the prebuilt release ZIP.
//
// A declared WorkflowEntrypoint class must be provably exported by the entry
// module graph before the release is sealed: the Workflows API applies
// `class_name` to the exact active version, and a release that cannot prove
// the export exists must never be sealed. This is deliberately not a bundler:
// comments, strings, template literals and regex literals are masked, and only
// export forms this scanner fully understands count. ANY unrecognized `export`
// occurrence, a bare/non-relative re-export specifier, an unresolvable
// relative re-export, an unterminated construct or a non-UTF8 module makes the
// scan inconclusive — and inconclusive is a refusal, never a silent pass.

export interface NamedReexport {
  /** Identifier names claimed from the target module. */
  names: string[];
  /** The exact `from "..."` specifier. */
  specifier: string;
}

export interface EsmModuleExports {
  /** Named exports declared by this module itself (direct or `export * as ns`). */
  names: string[];
  /** Relative specifiers re-exported wholesale (`export * from "..."`). */
  starFrom: string[];
  /**
   * Named re-exports (`export { a, b as c } from "..."`). The listed names are
   * NOT this module's own claims: the caller must verify each one against the
   * resolved target, otherwise a barrel could vouch for a class it never had.
   */
  namedFrom: NamedReexport[];
  /** True when an export form or construct could not be fully classified. */
  inconclusive: boolean;
}

export interface ReachableEsmExports {
  /** False when the scan could not fully classify the module graph. */
  ok: boolean;
  /** Every named export reachable from the entry module. */
  names: Set<string>;
}

type Token =
  | { kind: "ident"; text: string }
  | { kind: "string"; text: string }
  | { kind: "punct"; text: string }
  | { kind: "other" };

const IDENT_START = /[A-Za-z_$]/;
const IDENT_TAIL = /[A-Za-z0-9_$]/;

// A `/` starts a regex literal only after specific punctuation or keywords.
const REGEX_AFTER_PUNCT = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  ";",
  "{",
  "}",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "^",
  "~",
]);
const REGEX_AFTER_KEYWORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "do",
  "else",
  "case",
  "yield",
  "await",
]);

// Tokenizes ESM source into idents / strings / puncts, treating comments,
// template literals and regex literals as unclassifiable filler ("other").
// `inconclusive` is set when a construct is unterminated or cannot be resolved
// into tokens at all.
function tokenize(source: string): { tokens: Token[]; inconclusive: boolean } {
  const tokens: Token[] = [];
  let inconclusive = false;
  let i = 0;
  const n = source.length;
  let prev: Token | undefined;
  const regexAllowed = (): boolean => {
    if (prev === undefined) return true;
    if (prev.kind === "ident") return REGEX_AFTER_KEYWORD.has(prev.text);
    if (prev.kind === "punct") return REGEX_AFTER_PUNCT.has(prev.text);
    return false;
  };
  const push = (token: Token) => {
    tokens.push(token);
    prev = token;
  };
  while (i < n) {
    const ch = source[i]!;
    // comments
    if (ch === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) {
        inconclusive = true;
        i = n;
      } else {
        i = end + 2;
      }
      continue;
    }
    // regex literal
    if (ch === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      let terminated = false;
      while (j < n) {
        const c = source[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") break;
        if (inClass) {
          if (c === "]") inClass = false;
        } else if (c === "[") {
          inClass = true;
        } else if (c === "/") {
          terminated = true;
          break;
        }
        j++;
      }
      if (!terminated) {
        inconclusive = true;
        i = n;
        continue;
      }
      i = j + 1;
      while (i < n && IDENT_TAIL.test(source[i]!)) i++;
      push({ kind: "other" });
      continue;
    }
    // strings
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let terminated = false;
      let text = "";
      while (j < n) {
        const c = source[j]!;
        if (c === "\\") {
          text += source.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (c === "\n") break;
        if (c === ch) {
          terminated = true;
          break;
        }
        text += c;
        j++;
      }
      if (!terminated) {
        inconclusive = true;
        i = n;
        continue;
      }
      i = j + 1;
      push({ kind: "string", text });
      continue;
    }
    // template literals: opaque. `export` cannot appear inside an expression,
    // so nothing inside a template can be a module export.
    if (ch === "`") {
      let j = i + 1;
      let terminated = false;
      while (j < n) {
        const c = source[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "`") {
          terminated = true;
          break;
        }
        j++;
      }
      if (!terminated) {
        inconclusive = true;
        i = n;
        continue;
      }
      i = j + 1;
      push({ kind: "other" });
      continue;
    }
    // identifiers / keywords
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < n && IDENT_TAIL.test(source[j]!)) j++;
      push({ kind: "ident", text: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    push({ kind: "punct", text: ch });
    i++;
  }
  return { tokens, inconclusive };
}

/** Classifies the export forms of one module source. */
export function scanEsmExports(source: string): EsmModuleExports {
  const { tokens, inconclusive: tokenInconclusive } = tokenize(source);
  const names = new Set<string>();
  const starFrom: string[] = [];
  const namedFrom: NamedReexport[] = [];
  let inconclusive = tokenInconclusive;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.kind !== "ident" || token.text !== "export") {
      i++;
      continue;
    }
    // `foo.export` / `foo?.export` is a property access, not a statement.
    const previous = tokens[i - 1];
    if (previous?.kind === "punct" && previous.text === ".") {
      i++;
      continue;
    }
    const next = tokens[i + 1];
    if (next === undefined) {
      inconclusive = true;
      break;
    }
    if (next.kind === "ident" && next.text === "default") {
      i += 2;
      continue;
    }
    if (next.kind === "ident" && (next.text === "function" || next.text === "class")) {
      const name = tokens[i + 2];
      if (name?.kind === "ident") {
        names.add(name.text);
        i += 3;
      } else {
        inconclusive = true;
        i += 2;
      }
      continue;
    }
    if (next.kind === "ident" && next.text === "async") {
      const fn = tokens[i + 2];
      const name = tokens[i + 3];
      if (fn?.kind === "ident" && fn.text === "function" && name?.kind === "ident") {
        names.add(name.text);
        i += 4;
      } else {
        inconclusive = true;
        i += 2;
      }
      continue;
    }
    if (next.kind === "ident" && (next.text === "const" || next.text === "let" || next.text === "var")) {
      const name = tokens[i + 2];
      if (name?.kind === "ident") {
        names.add(name.text);
        i += 3;
      } else if (name?.kind === "punct" && (name.text === "{" || name.text === "[")) {
        // destructuring: no name-addressable export
        i += 2;
      } else {
        inconclusive = true;
        i += 2;
      }
      continue;
    }
    if (next.kind === "punct" && next.text === "{") {
      // export { a, b as c } [from "specifier"]. Names in a `from` list are
      // the TARGET's claims, never this module's: they are recorded for
      // verification instead of being added.
      let j = i + 2;
      let closed = false;
      const group: string[] = [];
      while (j < tokens.length) {
        const item = tokens[j]!;
        if (item.kind === "punct" && item.text === "}") {
          closed = true;
          j++;
          break;
        }
        if (item.kind === "ident") {
          const asToken = tokens[j + 1];
          const alias = tokens[j + 2];
          if (asToken?.kind === "ident" && asToken.text === "as") {
            if (alias?.kind === "ident") {
              if (alias.text !== "default") group.push(alias.text);
              j += 3;
            } else if (alias?.kind === "string") {
              // `export { x as "name" }`: a string-named export contributes no
              // JS identifier (the old code wrongly reported `x`).
              j += 3;
            } else {
              inconclusive = true;
              j += 2;
            }
          } else {
            group.push(item.text);
            j += 1;
          }
          continue;
        }
        if (item.kind === "string") {
          // `export { "name" as x }` exports the identifier `x`; a bare
          // string name exports nothing addressable from JS.
          const asToken = tokens[j + 1];
          const alias = tokens[j + 2];
          if (asToken?.kind === "ident" && asToken.text === "as" && alias?.kind === "ident") {
            if (alias.text !== "default") group.push(alias.text);
            j += 3;
          } else {
            j += 1;
          }
          continue;
        }
        if (item.kind === "punct" && item.text === ",") {
          j++;
          continue;
        }
        inconclusive = true;
        j++;
      }
      if (!closed) inconclusive = true;
      const fromToken = tokens[j];
      const specToken = tokens[j + 1];
      if (fromToken?.kind === "ident" && fromToken.text === "from" && specToken?.kind === "string") {
        namedFrom.push({ names: group, specifier: specToken.text });
        i = j + 2;
      } else {
        for (const name of group) names.add(name);
        i = j;
      }
      continue;
    }
    if (next.kind === "punct" && next.text === "*") {
      const asToken = tokens[i + 2];
      const alias = tokens[i + 3];
      let j = i + 2;
      if (asToken?.kind === "ident" && asToken.text === "as" && alias?.kind === "ident") {
        names.add(alias.text);
        j = i + 4;
      }
      const fromToken = tokens[j];
      const specifier = tokens[j + 1];
      if (fromToken?.kind === "ident" && fromToken.text === "from" && specifier?.kind === "string") {
        if (!(asToken?.kind === "ident" && asToken.text === "as")) {
          starFrom.push(specifier.text);
        }
        i = j + 2;
      } else {
        inconclusive = true;
        i = j;
      }
      continue;
    }
    inconclusive = true;
    i += 1;
  }
  return { names: [...names].sort(), starFrom, namedFrom, inconclusive };
}

function resolveRelative(
  fromPath: string,
  specifier: string,
  sources: ReadonlyMap<string, string>,
): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const segments = fromPath.split("/").slice(0, -1);
  for (const piece of specifier.split("/")) {
    if (piece === "" || piece === ".") continue;
    if (piece === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(piece);
  }
  const base = segments.join("/");
  for (const candidate of [base, `${base}.mjs`, `${base}.js`]) {
    if (sources.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolves the named exports reachable from `entryPath` through explicit
 * re-export chains. Any unresolvable/bare specifier, missing module,
 * inconclusive module scan, unverifiable named re-export, or ambiguous
 * multi-star name makes the result `ok: false` (the caller must refuse).
 *
 * Star-collision rule: one star source plus explicit names is exact (explicit
 * shadows the star, per ESM). The same name arriving via two DIFFERENT star
 * sources is ambiguous at link time, so it is excluded rather than guessed.
 */
export function reachableEsmExports(
  entryPath: string,
  sources: ReadonlyMap<string, string>,
): ReachableEsmExports {
  interface ModuleInfo {
    names: Set<string>;
    ambiguous: Set<string>;
    unverifiable: boolean;
  }
  const memo = new Map<string, ModuleInfo>();
  const visiting: string[] = [];
  const analyze = (path: string): ModuleInfo => {
    const done = memo.get(path);
    if (done) return done;
    // A re-export cycle can only shrink what is provable on this path: claim
    // nothing for the in-progress module (refusal, never false approval).
    if (visiting.includes(path)) return { names: new Set(), ambiguous: new Set(), unverifiable: false };
    const source = sources.get(path);
    if (source === undefined) return { names: new Set(), ambiguous: new Set(), unverifiable: true };
    visiting.push(path);
    const scanned = scanEsmExports(source);
    let unverifiable = scanned.inconclusive;
    const own = new Set(scanned.names);
    const starNames = new Set<string>();
    const ambiguous = new Set<string>();
    const starSources = new Map<string, string>();
    for (const specifier of scanned.starFrom) {
      const resolved = resolveRelative(path, specifier, sources);
      if (resolved === null) {
        unverifiable = true;
        continue;
      }
      const sub = analyze(resolved);
      if (sub.unverifiable) unverifiable = true;
      for (const name of sub.names) {
        if (own.has(name)) continue;
        const first = starSources.get(name);
        if (first === undefined) {
          starSources.set(name, resolved);
          starNames.add(name);
        } else if (first !== resolved) {
          starNames.delete(name);
          ambiguous.add(name);
        }
      }
      for (const name of sub.ambiguous) {
        if (!own.has(name)) {
          starNames.delete(name);
          ambiguous.add(name);
        }
      }
    }
    for (const reexport of scanned.namedFrom) {
      const resolved = resolveRelative(path, reexport.specifier, sources);
      if (resolved === null) {
        unverifiable = true;
        continue;
      }
      const sub = analyze(resolved);
      if (sub.unverifiable) {
        unverifiable = true;
        continue;
      }
      for (const name of reexport.names) {
        // The target must provably export the name and provably unambiguously:
        // a barrel vouching for a class its target lacks (or only ambiguously
        // provides) is unverifiable, never silently accepted.
        if (!sub.names.has(name) || sub.ambiguous.has(name)) {
          unverifiable = true;
        } else if (!own.has(name)) {
          starNames.add(name);
          starSources.set(name, resolved);
        }
      }
    }
    visiting.pop();
    const info: ModuleInfo = { names: new Set([...own, ...starNames]), ambiguous, unverifiable };
    memo.set(path, info);
    return info;
  };
  const entry = analyze(entryPath);
  return { ok: !entry.unverifiable, names: entry.names };
}
