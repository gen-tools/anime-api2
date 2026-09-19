/**
 * Dean Edwards `p,a,c,k,e,d` unpacker.
 *
 * Nearly every embed host in this library ships its player config inside
 * `eval(function(p,a,c,k,e,d){...}('payload',62,123,'word|list'.split('|'),0,{}))`.
 * The stream URL only exists as a set of dictionary indices until the packer is
 * reversed, so extraction regexes have to run on the unpacked source.
 *
 * The payload is decoded arithmetically rather than by evaluating it: these
 * pages are hostile input, and `eval`/`new Function` would hand them arbitrary
 * code execution inside the extension process.
 */

/**
 * Find every complete `eval(function(p,a,c,k,e,d)...)` call in `input`.
 *
 * A regex cannot do this reliably — the payload contains unbalanced parens and
 * quoted brackets — so the call is scanned character by character, tracking
 * quote state so parens inside string literals do not affect the depth count.
 */
function extractEvalBlocks(input: string): string[] {
  const blocks: string[] = [];
  let pos = 0;

  for (;;) {
    const start = input.indexOf('eval(function(p,a,c,k,e,d)', pos);
    if (start === -1) break;

    let i = start;
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (; i < input.length; i++) {
      const ch = input[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (!inDouble && ch === "'") inSingle = !inSingle;
      else if (!inSingle && ch === '"') inDouble = !inDouble;
      if (inSingle || inDouble) continue;

      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }

    if (i > start) blocks.push(input.slice(start, i));
    pos = i;
  }

  return blocks;
}

interface StringToken {
  value: string;
  end: number;
}

/** Read a single- or double-quoted JS string literal starting at `start`. */
function parseString(src: string, start: number): StringToken | null {
  const quote = src[start];
  if (quote !== "'" && quote !== '"') return null;

  let out = '';
  let escaped = false;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === quote) return { value: out, end: i + 1 };
    out += ch;
  }
  return null;
}

function skipWs(src: string, i: number): number {
  let j = i;
  while (j < src.length && /\s/.test(src[j])) j++;
  return j;
}

function parseIntAt(src: string, i: number): StringToken | null {
  const at = skipWs(src, i);
  const m = src.slice(at).match(/^\d+/);
  if (!m) return null;
  return { value: m[0], end: at + m[0].length };
}

/**
 * Decode one extracted block back to its original source.
 *
 * The four arguments after `}(` are the packed payload, the radix, the word
 * count and the `|`-joined dictionary. Anything that does not match that exact
 * shape (including a missing `.split('|')`) is rejected rather than guessed at,
 * since a partial decode would corrupt the surrounding page.
 */
function decodeBlock(block: string): string | null {
  const callStart = block.indexOf('}(');
  if (callStart === -1) return null;

  let i = skipWs(block, callStart + 2);

  const pStr = parseString(block, i);
  if (!pStr) return null;
  const p = pStr.value;
  i = skipWs(block, pStr.end);
  if (block[i] !== ',') return null;

  const aNum = parseIntAt(block, i + 1);
  if (!aNum) return null;
  const a = parseInt(aNum.value, 10);
  i = skipWs(block, aNum.end);
  if (block[i] !== ',') return null;

  const cNum = parseIntAt(block, i + 1);
  if (!cNum) return null;
  let c = parseInt(cNum.value, 10);
  i = skipWs(block, cNum.end);
  if (block[i] !== ',') return null;

  const kStr = parseString(block, skipWs(block, i + 1));
  if (!kStr) return null;
  const splitPart = block.slice(kStr.end, kStr.end + 20);
  if (!/\.split\(\s*['"]\|['"]\s*\)/.test(splitPart)) return null;
  const k = kStr.value.split('|');

  // The packer's own base-`a` encoder, used to rebuild the token → word map.
  const encode = (x: number): string => {
    const prefix = x < a ? '' : encode(Math.floor(x / a));
    const rem = x % a;
    return prefix + (rem > 35 ? String.fromCharCode(rem + 29) : rem.toString(36));
  };

  const dict: Record<string, string> = {};
  while (c--) {
    const token = encode(c);
    dict[token] = k[c] || token;
  }

  return p.replace(/\b\w+\b/g, (w) => dict[w] || w);
}

/**
 * Unpack every packed block in `code`, leaving the rest of the document intact.
 *
 * Always returns a string: callers feed the result straight into their
 * extraction regexes, so a failed decode has to degrade to the original source
 * rather than throw or return null.
 */
export function unpack(code: string): string {
  try {
    if (!code || !code.includes('p,a,c,k,e,d')) return code;

    let result = code;
    for (const block of extractEvalBlocks(code)) {
      try {
        const decoded = decodeBlock(block);
        // Replacer function, not a string: decoded player code contains `$`
        // sequences that String.replace would otherwise treat as capture-group
        // references and mangle.
        if (decoded) result = result.replace(block, () => decoded);
      } catch {
        /* leave this block packed */
      }
    }

    return result;
  } catch {
    return code;
  }
}
