// Drakonc Shell Desktop design tokens: the values of design/herdr-desktop/01-inspector.html
// (`:root` lines 13-35 and the component CSS), for every Drakonc Shell Desktop mod.
//
// SHARED MODULE. This file is the one source for the centre column (drakonc-chat, T5) and the
// sidebar / inspector / status mods (T6). A mod can only import files inside its own folder,
// so T6 mods carry a byte-for-byte COPY of this file; edit it here first, then re-copy it
// (`cp herdr/mods/drakonc-chat/tokens.js herdr/mods/<mod>/tokens.js`). Pure: no host calls at
// module level (mods reload in place), only `herdr` reads inside the functions.
//
// Colour policy (T5 brief): a token with a Herdr theme role reads `theme()[role]`, so the
// window follows the layout's theme and the theme picker; a token without a role is the exact
// artboard hex. The layout (herdr/layouts/drakonc-shell.json) makes the roles equal the artboard
// through its root `"theme": { "light": "drakonc-shell-light", "dark": "drakonc-shell-dark" }`
// (S14): herdr/themes/drakonc-shell-dark.json carries LAYOUT_COLORS in its `colors`, the light
// file LIGHT_COLORS; without them, the roles show the person's theme (graphite, ...) and only the
// hex tokens stay Drakonc. The hex of the appearance Herdr shows (`settings().dark`) is used.

import { fonts, settings } from "herdr";

// name: [hex de marca, papel de Herdr o null, origen]. Los hex oscuros son la paleta de marca
// (espejo de herdr/themes/drakonc-shell-dark.json `colors`), no los del artboard heredado.
const TOKENS = {
  // The artboard paints both with --canvas (l.15): the window behind the cards (Herdr `canvas`)
  // and the centre card itself (.views l.258, Herdr `background` = the terminals' cards). Inside
  // the chat, every var(--canvas) is the card surface, so drakonc-chat uses `background`.
  canvas: ["#0d1526", "canvas", "--canvas (Drakoncman-Cute bg) l.15, behind the cards"],
  background: ["#0d1526", "background", "--canvas on .views l.258, the centre card surface"],
  chrome: ["#121d31", "chrome", "--chrome (bgPanel) l.16"],
  surface: ["#17233a", "surface", "--surface (system.md --surface) l.17"],
  raised: ["#1f2c44", "raised", "--raised (system.md --surface-1) l.18"],
  user: ["#24304a", null, "--user (userMessageBg) l.19"],
  selected: ["#24304a", "selected", "--selected (selection) l.20"],
  hover: ["#24304a", "hover", "--selected is also the hover fill l.20"],
  line: ["#334158", "border", "--line (borderSubtle) l.21"],
  lineStrong: ["#3a4a66", "input", "--line-strong (border) l.22"],
  text: ["#e6edf7", "foreground", "--text l.23"],
  muted: ["#a9b7ca", "muted", "--muted l.24"],
  faint: ["#8593a8", "dim", "--faint l.25"],
  accent: ["#ff4d5e", "accent", "--accent l.26"],
  accentSoft: ["#ff8993", null, "--accent-soft l.27"],
  ok: ["#b4e7c7", "done", "--ok l.28"],
  warn: ["#e0c27a", "blocked", "--warn l.29"],
  err: ["#ff718f", null, "--err l.30"],
  info: ["#a9c7ee", "working", "--info l.31"],
  onAccent: ["#0d1526", null, ".btn.primary / .send text l.94, l.183"],
  btnLine: ["#ffffff17", null, ".btn border l.92"],
};

// Lo que `colors` del layout fija para que cada papel de arriba muestre el valor de marca (T6).
// `popover` (menus) and the primary button roles have no token of their own here but the
// artboard fixes them too (l.107, l.94).
export const LAYOUT_COLORS = {
  ...Object.fromEntries(Object.values(TOKENS).filter(([, role]) => role).map(([hex, role]) => [role, hex])),
  popover: "#1f2c44",
  accent_foreground: "#0d1526",
  solid: "#ff4d5e",
  solid_foreground: "#0d1526",
};

// The light appearance (S14): the same names, derived from design/system.md (no light artboard;
// herdr/FIDELITY-light.md has every value and its WCAG contrast). Same values as
// herdr/mods/drakonc-tokens/tokens.js HEX_LIGHT.
const LIGHT = {
  canvas: "#f7f9fc",
  background: "#f7f9fc",
  chrome: "#eef2f8",
  surface: "#e9eef6",
  raised: "#e2e9f4",
  user: "#fde8ea",
  selected: "#fde3e6",
  hover: "#fde3e6",
  line: "#dbe3ee",
  lineStrong: "#c2cddd",
  text: "#0d1526",
  muted: "#4a5666",
  faint: "#6b7789",
  accent: "#b32636",
  accentSoft: "#8f2233",
  ok: "#1d6b43",
  warn: "#7f5300",
  err: "#b3203f",
  info: "#22589c",
  onAccent: "#ffffff",
  btnLine: "#0d15261f",
};

// What herdr/themes/drakonc-shell-light.json `colors` sets (the light LAYOUT_COLORS).
export const LIGHT_COLORS = {
  ...Object.fromEntries(Object.entries(TOKENS).filter(([, [, role]]) => role).map(([name, [, role]]) => [role, LIGHT[name]])),
  popover: "#ffffff",
  accent_foreground: "#ffffff",
  solid: "#b32636",
  solid_foreground: "#ffffff",
  idle: "#4a5666",
  selection: "#b3263633",
};

const isColor = (v) => typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v);

// Whether Herdr shows the dark appearance now (settings().dark); dark when it does not say.
export function isDark() {
  try { return settings()?.dark !== false; } catch { return true; }
}

// The palette for one render: `t` is `theme()`.
export function palette(t) {
  const p = {};
  const dark = isDark();
  for (const [name, [hex, role]] of Object.entries(TOKENS)) {
    const own = dark ? hex : LIGHT[name];
    p[name] = role && isColor(t?.[role]) ? t[role] : own;
  }
  return p;
}

// `#rrggbb` + alpha (0..1) → `#rrggbbaa`, as the artboard's 8-digit hexes (`#e0c27a14`).
export function alpha(color, a) {
  const c = String(color);
  const six = /^#[0-9a-fA-F]{6}$/.test(c) ? c : /^#[0-9a-fA-F]{8}$/.test(c) ? c.slice(0, 7) : null;
  if (!six) return c;
  return six + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0");
}

// Type: --sans / --mono stacks (l.32-33). The first installed family wins, like CSS.
const SANS = ["Inter", "SF Pro Text", "SF Pro", ".SystemUIFont"];
const MONO = ["IosevkaTerm NF", "Iosevka Term", "JetBrains Mono", "SF Mono", "Menlo"];
let installed = null;
function pick(stack) {
  if (!installed) {
    try { installed = new Set(fonts()); } catch { installed = new Set(); }
  }
  return stack.find((f) => installed.has(f)) ?? stack[stack.length - 1];
}
export const sans = () => pick(SANS);
export const mono = () => pick(MONO);

// Radii (l.34) and the window's own numbers.
export const R = { sm: 8, md: 12, lg: 16, pill: 999, inner: 6, kbd: 5, window: 10 };
