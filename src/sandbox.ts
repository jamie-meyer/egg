// Generated views are untrusted: a model wrote them right after reading
// arbitrary files. Each is shown in an iframe with `srcdoc` and an empty
// `sandbox` attribute (no scripts, no same-origin, no forms, no popups, no
// top navigation), and the document itself carries a Content-Security-Policy
// that blocks every network request. What could still leave the frame
// without a script (a meta refresh, a <link> prefetch, a clicked link) is
// taken out of the markup before it is shown.

/** The iframe's sandbox attribute. Never add allow-same-origin. */
export const VIEW_SANDBOX = "";

export const VIEW_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "media-src data:",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

export interface ViewTheme {
  background: string;
  foreground: string;
  muted: string;
  border: string;
  font: string;
  mono: string;
  scheme: "light" | "dark";
}

export const PLAIN_THEME: ViewTheme = {
  background: "#ffffff",
  foreground: "#1f1f1f",
  muted: "#6b6b6b",
  border: "#dddddd",
  font: "system-ui, sans-serif",
  mono: "ui-monospace, monospace",
  scheme: "light",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** CSS values come from bb's theme; keep only characters a colour or font list needs. */
function cssValue(value: string, fallback: string): string {
  const v = value.trim();
  return v && /^[#(),.%/\w\s'"-]+$/.test(v) && !/url\s*\(/i.test(v) ? v : fallback;
}

/**
 * Take out what could reach the network or bb without a script: meta
 * refresh and other http-equiv tags, <link>, <base>, embedded frames and
 * objects, and link targets (a link keeps its text; its address is shown
 * as a tooltip only).
 */
export function defang(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<(iframe|frame|frameset|object|embed|portal)\b[\s\S]*?(<\/\1\s*>|\/?>)/gi, "")
    .replace(/\s(?:xlink:)?href\s*=\s*("(?![#])[^"]*"|'(?![#])[^']*'|(?!["'#])[^\s>]+)/gi, " title=$1")
    .replace(/\s(src|srcset|poster|background|action|formaction|data|ping)\s*=\s*("(?!data:)[^"]*"|'(?!data:)[^']*'|(?!["'])(?!data:)[^\s>]+)/gi, "");
}

function baseStyle(theme: ViewTheme): string {
  const bg = cssValue(theme.background, PLAIN_THEME.background);
  const fg = cssValue(theme.foreground, PLAIN_THEME.foreground);
  const muted = cssValue(theme.muted, PLAIN_THEME.muted);
  const border = cssValue(theme.border, PLAIN_THEME.border);
  const font = cssValue(theme.font, PLAIN_THEME.font);
  const mono = cssValue(theme.mono, PLAIN_THEME.mono);
  return `:root{color-scheme:${theme.scheme === "dark" ? "dark" : "light"};--egg-bg:${bg};--egg-fg:${fg};--egg-muted:${muted};--egg-border:${border}}
html,body{margin:0;background:${bg};color:${fg};font:13px/1.45 ${font}}
body{padding:12px 14px}
pre.egg-text{margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ${mono}}
a{color:inherit;text-decoration:underline dotted;cursor:default}`;
}

/** The whole srcdoc for a view. Our CSP comes first, before anything the model wrote. */
export function viewDocument(format: "html" | "text", content: string, theme: ViewTheme = PLAIN_THEME): string {
  const head = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}"><meta name="referrer" content="no-referrer"><style>${baseStyle(theme)}</style></head>`;
  if (format === "text") return `${head}<body><pre class="egg-text">${escapeHtml(content)}</pre></body></html>`;
  return `${head}<body>${defang(content)}</body></html>`;
}
