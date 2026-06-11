/**
 * Parse a bash command string into its constituent segments,
 * respecting quoted strings and subshell nesting.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ParsedSegment {
  /** The raw text of this segment, stripped of leading/trailing whitespace. */
  text: string;

  /** The operator that connects this segment to the previous one.
   *  null for the first segment. */
  operator: "&&" | "||" | ";" | "|" | null;

  /** Position in the chain (0-based). */
  index: number;
}

export interface ParseResult {
  /** All top-level segments in order. */
  segments: ParsedSegment[];

  /**
   * If true, the command is a simple single command with no chaining.
   */
  isSimple: boolean;

  /** Always 0. Kept for interface compatibility. */
  primaryIndex: number;

  /**
   * The operator types used in this chain (deduplicated).
   */
  operators: Array<"&&" | "||" | ";" | "|">;
}

// ---------------------------------------------------------------------------
// Tokenizer helpers
// ---------------------------------------------------------------------------

interface Token {
  type: "text" | "operator" | "string-single" | "string-double" | "subshell";
  value: string;
}

/**
 * Very simple char-by-char tokenizer that splits a bash command into
 * tokens, tracking quote and paren nesting.
 */
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  const chars = [...command];
  let i = 0;

  while (i < chars.length) {
    // Skip whitespace between tokens (we'll reconstruct spaces inside text)
    if (/^\s$/.test(chars[i])) {
      i++;
      continue;
    }

    // Single-quoted string: everything until closing quote
    if (chars[i] === "'") {
      const start = i;
      i++;
      while (i < chars.length && chars[i] !== "'") i++;
      if (i < chars.length) i++; // skip closing quote
      tokens.push({ type: "string-single", value: command.slice(start, i) });
      continue;
    }

    // Double-quoted string: everything until closing quote (careful with \")
    if (chars[i] === '"') {
      const start = i;
      i++;
      while (i < chars.length) {
        if (chars[i] === '\\' && i + 1 < chars.length) {
          i += 2; // skip escaped char
          continue;
        }
        if (chars[i] === '"') break;
        i++;
      }
      if (i < chars.length) i++; // skip closing quote
      tokens.push({ type: "string-double", value: command.slice(start, i) });
      continue;
    }

    // Subshell: track nesting
    if (chars[i] === "$" && i + 1 < chars.length && chars[i + 1] === "(") {
      // Find matching closing )
      const start = i;
      i += 2;
      let depth = 1;
      while (i < chars.length && depth > 0) {
        if (chars[i] === "(") depth++;
        if (chars[i] === ")") depth--;
        if (depth > 0) i++;
      }
      if (i < chars.length) i++; // skip closing )
      tokens.push({ type: "subshell", value: command.slice(start, i) });
      continue;
    }

    // Parenthesized subshell: ( ... )
    if (chars[i] === "(") {
      const start = i;
      let depth = 1;
      i++;
      while (i < chars.length && depth > 0) {
        if (chars[i] === "(") depth++;
        if (chars[i] === ")") depth--;
        if (depth > 0) i++;
      }
      if (i < chars.length) i++;
      tokens.push({ type: "subshell", value: command.slice(start, i) });
      continue;
    }

    // Operators: &&, ||, ;, |
    if (chars[i] === "&" && i + 1 < chars.length && chars[i + 1] === "&") {
      tokens.push({ type: "operator", value: "&&" });
      i += 2;
      continue;
    }
    if (chars[i] === "|" && i + 1 < chars.length && chars[i + 1] === "|") {
      tokens.push({ type: "operator", value: "||" });
      i += 2;
      continue;
    }
    if (chars[i] === ";" && chars[i + 1] !== ";") {
      // ;; is case separator, not command chaining
      tokens.push({ type: "operator", value: ";" });
      i++;
      continue;
    }
    if (chars[i] === "|" && chars[i + 1] !== "|" && chars[i + 1] !== "&") {
      // single pipe (not ||, not |&)
      tokens.push({ type: "operator", value: "|" });
      i++;
      continue;
    }

    // Everything else: accumulate as text
    // Stop at whitespace, operators, quotes, parens
    const start = i;
    while (i < chars.length) {
      if (/^\s$/.test(chars[i])) break;
      if (chars[i] === "'" || chars[i] === '"') break;
      if (chars[i] === "(" || chars[i] === ")") break;
      if (chars[i] === "&" && chars[i + 1] === "&") break;
      if (chars[i] === "|" && chars[i + 1] === "|") break;
      if (chars[i] === ";" && chars[i + 1] !== ";") break;
      if (chars[i] === "|" && chars[i + 1] !== "|" && chars[i + 1] !== "&") break;
      i++;
    }
    if (i > start) {
      tokens.push({ type: "text", value: command.slice(start, i) });
    }
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a bash command string into its top-level segments using
 * &&, ||, ;, and | as separators.
 *
 * Does NOT handle:
 *   - Backgrounding (&)
 *   - Here-docs (<<, <<-)
 *   - Case statements (;;)
 */
export function parseBashCommand(command: string): ParseResult {
  const tokens = tokenize(command);
  const opsFound = new Set<"&&" | "||" | ";" | "|">();

  // Collect raw text blocks and operators in order
  const parts: Array<
    { type: "text"; text: string } | { type: "op"; op: string }
  > = [];
  let currentText = "";

  for (const token of tokens) {
    if (token.type === "operator") {
      const trimmed = currentText.trim();
      if (trimmed) {
        parts.push({ type: "text", text: trimmed });
      }
      parts.push({ type: "op", op: token.value });
      opsFound.add(token.value as "&&" | "||" | ";" | "|");
      currentText = "";
    } else {
      if (currentText && !currentText.endsWith(" ")) currentText += " ";
      currentText += token.value;
    }
  }
  const trimmed = currentText.trim();
  if (trimmed) {
    parts.push({ type: "text", text: trimmed });
  }

  // Reconstruct segments: each text block gets the operator before it
  const segments: ParsedSegment[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.type === "text") {
      const prevPart = i > 0 ? parts[i - 1] : null;
      const prevOp =
        prevPart && prevPart.type === "op"
          ? (prevPart.op as "&&" | "||" | ";" | "|")
          : null;
      segments.push({
        text: part.text,
        operator: prevOp,
        index: segments.length,
      });
    }
  }

  const operators = [...opsFound] as Array<"&&" | "||" | ";" | "|">;
  const isSimple = segments.length <= 1;

  return { segments, isSimple, primaryIndex: 0, operators };
}




