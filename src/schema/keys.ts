export class InvalidResourceError extends Error {
  readonly code = "invalid_resource";
  constructor() {
    super("invalid_resource: expected a valid resource key of at most 512 UTF-8 bytes");
    this.name = "InvalidResourceError";
  }
}

/** NFC and a trailing tree slash are normalized; unsafe path segments are rejected. */
export function canonicalKey(raw: string): string {
  if (typeof raw !== "string" || /[\uD800-\uDFFF]/u.test(raw)) throw new InvalidResourceError();
  const normalized = raw.normalize("NFC");
  const match = /^(path|tree|branch|env|res|seq):(.+)$/u.exec(normalized);
  if (!match) throw new InvalidResourceError();
  const [, kind, value] = match;
  const name = kind === "tree" && value.endsWith("/") ? value.slice(0, -1) : value;
  if (/[\\\u0000-\u001f\u007f-\u009f]/u.test(name) ||
      name.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
      ((kind === "branch" || kind === "res") && /\s/u.test(name)) ||
      (kind === "env" && !/^[a-z0-9][a-z0-9-]*$/u.test(name)) ||
      (kind === "seq" && !/^[a-z0-9][a-z0-9_-]*$/u.test(name))) {
    throw new InvalidResourceError();
  }
  const key = `${kind}:${name}${kind === "tree" ? "/" : ""}`;
  if (Buffer.byteLength(key, "utf8") > 512) throw new InvalidResourceError();
  return key;
}

/** Sequence keys are valid resources for reservations, but never lease resources. */
export function isLeasableKey(raw: string): boolean {
  return !canonicalKey(raw).startsWith("seq:");
}

/** Case-folded canonical key used for every overlap comparison and the lease_keys index.
 * Upper-then-lower folds contextual forms (final sigma) that a plain toLowerCase keeps apart. */
export function foldKey(raw: string): string {
  return canonicalKey(raw).toUpperCase().toLowerCase();
}

export function overlaps(a: string, b: string): boolean {
  const left = foldKey(a);
  const right = foldKey(b);
  if (left.startsWith("seq:") || right.startsWith("seq:")) return false;
  if (left === right) return true;
  const [lk, ...lv] = left.split(":");
  const [rk, ...rv] = right.split(":");
  const lp = lv.join(":");
  const rp = rv.join(":");
  return (lk === "tree" && (rk === "path" || rk === "tree") && rp.startsWith(lp)) ||
    (rk === "tree" && (lk === "path" || lk === "tree") && lp.startsWith(rp));
}
