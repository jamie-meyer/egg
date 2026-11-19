// Generated views are untrusted: a model wrote them right after reading
// arbitrary files, and those files can tell it what to write. A view must
// not be able to send anything anywhere or reach bb's page. Three layers:
//
// 1. The view's HTML is parsed (by the browser, into an inert document) and
//    only allowlisted elements and attributes are written back out; nothing
//    that holds an address survives (see sanitizeHtml).
// 2. It is shown in an iframe with `srcdoc` and an empty `sandbox` attribute
//    (no scripts, no same origin, no forms, no popups, no navigating other
//    frames), and its document carries a Content-Security-Policy that blocks
//    every request.
// 3. That iframe sits inside a second `srcdoc` frame written by egg, whose
//    policy has `frame-src 'none'`. A frame navigating itself (a clicked
//    link, a refresh) is not stopped by its own policy, but it is checked
//    against its parent's frame-src, so the navigation is blocked before
//    any request is made. scripts/sandbox-check.mjs shows this in Chrome.

/** The sandbox attribute of both frames. Never add allow-same-origin. */
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

/**
 * The policy of egg's outer frame. frame-src 'none' still lets the inner
 * `srcdoc` frame load, and blocks it from navigating anywhere afterwards.
 */
export const FRAME_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
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

/** Parses HTML into an inert document (no scripts run, nothing loads). */
export type HtmlParser = (html: string) => Document;

/** The browser's own parser; what the page uses. */
export const browserParser: HtmlParser = (html) => new DOMParser().parseFromString(html, "text/html");

// Elements kept as they are (their children are sanitised in turn).
const HTML_ELEMENTS = new Set(
  ("div span p br hr h1 h2 h3 h4 h5 h6 strong b em i u s small big sub sup mark code pre kbd samp var " +
    "blockquote q cite abbr dfn time del ins wbr bdi bdo ruby rt rp data meter progress label " +
    "ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col " +
    "details summary figure figcaption section article header footer main nav aside address hgroup " +
    "img a").split(" "),
);
const VOID_ELEMENTS = new Set(["br", "hr", "img", "wbr", "col"]);
// SVG shapes, text and paint servers. Keyed by lower case (parsers differ on
// case); written out in their proper case.
const SVG_ELEMENTS = new Map(
  ("svg g path rect circle ellipse line polyline polygon text tspan defs linearGradient radialGradient stop " +
    "title desc marker clipPath symbol pattern mask").split(" ").map((n) => [n.toLowerCase(), n]),
);
// Removed with everything inside them. Anything else that is not allowed is
// unwrapped: the element goes, its children are sanitised and kept.
const DROPPED_ELEMENTS = new Set(
  ("script style template iframe frame frameset noframes object embed applet portal fencedframe " +
    "meta link base title head form input select textarea option optgroup datalist button output fieldset legend " +
    "audio video source track canvas math foreignobject image use textpath feimage animate set animatemotion animatetransform discard").split(" "),
);

const GLOBAL_ATTRIBUTES = new Set(["class", "title", "style", "id", "lang", "dir", "role"]);
const HTML_ATTRIBUTES = new Set(
  ("colspan rowspan scope headers abbr span align valign width height border cellpadding cellspacing " +
    "open start reversed type value min max low high optimum alt datetime").split(" "),
);
const SVG_ATTRIBUTES = new Map(
  ("viewBox preserveAspectRatio width height x y x1 y1 x2 y2 cx cy r rx ry fx fy fr d points pathLength transform " +
    "fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit " +
    "stroke-dasharray stroke-dashoffset opacity color visibility display vector-effect shape-rendering " +
    "font-family font-size font-weight font-style text-anchor dominant-baseline alignment-baseline baseline-shift " +
    "letter-spacing word-spacing text-decoration dx dy rotate textLength lengthAdjust writing-mode " +
    "offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod " +
    "marker-start marker-mid marker-end markerWidth markerHeight markerUnits refX refY orient " +
    "clip-path clip-rule clipPathUnits mask maskUnits maskContentUnits patternUnits patternContentUnits patternTransform").split(" ").map((n) => [n.toLowerCase(), n]),
);

// CSS functions that fetch something. url() survives only with a data: or #fragment address.
const FETCHING_FUNCTION = /(^|[^a-z0-9_\\-])(-webkit-image-set|image-set|-webkit-cross-fade|cross-fade|image|element|src|url)(\s*\()(\s*["']?)(data:|#)?/gi;

/**
 * Make CSS unable to fetch anything: @import and every url() that is not
 * data: or #fragment are made invalid, so the browser ignores them. Escapes
 * outside strings are decoded first, so `u\72l(` cannot hide a url(); `<`
 * is escaped everywhere, so the CSS cannot end its <style> element.
 */
export function sanitizeCss(css: string): string {
  let out = "";
  let i = 0;
  const n = css.length;
  while (i < n) {
    const c = css[i]!;
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      out += " ";
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && css[j] !== c && css[j] !== "\n") j += css[j] === "\\" ? 2 : 1;
      out += c + css.slice(i + 1, Math.min(j, n)).replace(/</g, "\\3c ") + c;
      i = j < n && css[j] === c ? j + 1 : Math.min(j, n);
    } else if (c === "\\") {
      const hex = /^[0-9a-fA-F]{1,6}\s?/.exec(css.slice(i + 1, i + 8));
      let code: number;
      if (hex) {
        code = parseInt(hex[0], 16);
        i += 1 + hex[0].length;
      } else if (i + 1 >= n) {
        break;
      } else if (css[i + 1] === "\n") {
        out += "\\5c ";
        i += 1;
        continue;
      } else {
        code = css.codePointAt(i + 1)!;
        i += 1 + String.fromCodePoint(code).length;
      }
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) code = 0xfffd;
      const ch = String.fromCodePoint(code);
      out += /[a-zA-Z_-]/.test(ch) || code > 0x7f ? ch : `\\${code.toString(16)} `;
    } else {
      out += c === "<" ? "\\3c " : c;
      i += 1;
    }
  }
  return out
    .replace(/@import/gi, "@egg-blocked")
    .replace(FETCHING_FUNCTION, (all, before: string, name: string, paren: string, quote: string, safe: string | undefined) =>
      name.toLowerCase() === "url" && safe ? all : `${before}egg-blocked${paren}${quote}${safe ?? ""}`,
    );
}

function allowedAttribute(name: string, value: string, element: string, svg: boolean): [string, string] | null {
  if (name.includes(":") || name.startsWith("on")) return null;
  if (name === "style") return [name, sanitizeCss(value)];
  if (GLOBAL_ATTRIBUTES.has(name) || /^(aria|data)-[a-z0-9-]+$/.test(name)) return [name, value];
  if (svg) {
    const proper = SVG_ATTRIBUTES.get(name);
    return proper ? [proper, sanitizeCss(value)] : null;
  }
  if (element === "img" && name === "src") return /^\s*data:image\//i.test(value) ? [name, value.trim()] : null;
  return HTML_ATTRIBUTES.has(name) ? [name, value] : null;
}

/**
 * Parse a view and keep only what is on the allowlist: text structure,
 * tables, lists, details, inline SVG shapes and text, styles. Every element
 * or attribute that could hold or follow an address is dropped (a link
 * keeps its text, and its address only as a tooltip); images keep only a
 * data: source. Styles anywhere in the view are gathered into one <style>
 * at the top, with their CSS made unable to fetch. The result is written
 * out by this function, not by the parser, so nothing outside the
 * allowlist can come back when the frame parses it again.
 */
export function sanitizeHtml(html: string, parse: HtmlParser): string {
  const doc = parse(html);
  const styles: string[] = [];
  const collectStyles = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1) continue;
      if ((child as Element).localName.toLowerCase() === "style") styles.push(child.textContent ?? "");
      else if ((child as Element).localName.toLowerCase() !== "template") collectStyles(child);
    }
  };
  if (doc.documentElement) collectStyles(doc.documentElement);

  const walk = (node: Node, svg: boolean): string => {
    let out = "";
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        out += escapeHtml(child.textContent ?? "");
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const name = el.localName.toLowerCase();
      if (DROPPED_ELEMENTS.has(name) && !(svg && name === "title")) continue;
      const inSvg = svg || name === "svg";
      const proper = inSvg ? SVG_ELEMENTS.get(name) : HTML_ELEMENTS.has(name) ? name : undefined;
      if (!proper) {
        out += walk(el, inSvg);
        continue;
      }
      let attrs = "";
      let href: string | undefined;
      let titled = false;
      for (const attr of Array.from(el.attributes)) {
        const lower = attr.name.toLowerCase();
        if (lower === "href") href = attr.value.trim();
        if (lower === "title") titled = true;
        const kept = allowedAttribute(lower, attr.value, name, inSvg);
        if (kept) attrs += ` ${kept[0]}="${escapeHtml(kept[1])}"`;
      }
      // A link keeps its text; its address is only shown as a tooltip.
      if (name === "a" && href && !titled) attrs += ` title="${escapeHtml(href)}"`;
      out += `<${proper}${attrs}>`;
      if (!inSvg && VOID_ELEMENTS.has(name)) continue;
      out += `${walk(el, inSvg)}</${proper}>`;
    }
    return out;
  };
  const body = doc.body ? walk(doc.body, false) : "";
  const css = styles.map(sanitizeCss).join("\n");
  return (css.trim() ? `<style>${css}</style>` : "") + body;
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

/**
 * The view's own document, shown in the inner frame. Our CSP comes first,
 * before anything the model wrote. Text views take bb's theme; HTML views
 * get a plain light page, since models write them for one.
 */
export function viewPage(format: "html" | "text", content: string, theme: ViewTheme = PLAIN_THEME, parse: HtmlParser = browserParser): string {
  const base = baseStyle(format === "text" ? theme : PLAIN_THEME);
  const head = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}"><meta name="referrer" content="no-referrer"><style>${base}</style></head>`;
  if (format === "text") return `${head}<body><pre class="egg-text">${escapeHtml(content)}</pre></body></html>`;
  return `${head}<body>${sanitizeHtml(content, parse)}</body></html>`;
}

/** egg's outer frame around an inner view document; see the top of this file. */
export function frameDocument(page: string, background: string = PLAIN_THEME.background): string {
  const bg = cssValue(background, PLAIN_THEME.background);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;height:100%;overflow:hidden;background:${bg}}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><iframe sandbox="${VIEW_SANDBOX}" tabindex="-1" referrerpolicy="no-referrer" srcdoc="${escapeHtml(page)}"></iframe></body></html>`;
}

/** The whole srcdoc for a view's iframe: egg's outer frame around the view's page. */
export function viewDocument(format: "html" | "text", content: string, theme: ViewTheme = PLAIN_THEME, parse: HtmlParser = browserParser): string {
  return frameDocument(viewPage(format, content, theme, parse), format === "text" ? theme.background : PLAIN_THEME.background);
}
