/**
 * theme-engine.js — the MagicMoney themes, rendered through ChainLens's palette.
 *
 * ⚠ HAND-KEPT PORT, like public/asset-filter-key.js. The sources of truth are in
 * the MagicMoney Wallet repo:
 *
 *   src/renderer/lib/color.ts          the colour maths
 *   src/renderer/lib/theme-tokens.ts   three colours -> the derived token set
 *   src/renderer/lib/builtin-themes.ts THEMES, the twelve shipped themes
 *   src/shared/theme-sync-wire.ts      the cl_themes wire shape
 *
 * Only the parts ChainLens renders from are ported: the derivation stops at the
 * seven tokens below rather than emitting the wallet's full CSS variable set,
 * because ChainLens has no stylesheet written against those names. Drift in the
 * DERIVATION is cosmetic (a theme looks slightly different in the two products);
 * drift in the WIRE shape is not (a theme silently fails to appear here at all).
 *
 * ── Why a palette and not a stylesheet ──────────────────────────────────────
 *
 * ChainLens is styled with Tailwind utility classes chosen by a `darkMode`
 * boolean — darkMode ? 'bg-slate-900' : 'bg-white', ~260 times. Nothing reads a
 * design token, so a theme cannot be applied by stamping tokens on <html> the
 * way the wallet does.
 *
 * Instead the Tailwind palette itself is the theme: index.html declares slate,
 * blue, cyan and white as rgb(var(--cl-…) / <alpha-value>), and a theme is a new
 * set of values for those variables. Every existing class keeps working,
 * including the alpha modifiers (bg-slate-900/60), gradients and rings.
 *
 * Two rules keep the recolour from breaking contrast the markup already relies on:
 *
 *   slate   is a page-background -> primary-text ramp, and the THEME'S TONE
 *           decides which end is which. The stops the app leans on land on the
 *           derived tokens (950/900/800 = the dark stack, 400/500 = muted text),
 *           so darkMode ? 'bg-slate-950' : 'bg-slate-50' still means "the page".
 *
 *   blue and cyan carry the accent's HUE and SATURATION at each stop's STOCK
 *           RELATIVE LUMINANCE. That is the load-bearing choice: the markup
 *           pairs bg-cyan-500 with dark text and bg-blue-600 with white text
 *           because stock cyan-500 is bright and stock blue-600 is dark. Holding
 *           luminance per stop keeps every one of those pairings readable for an
 *           accent of any hue, without touching the markup.
 *
 * emerald / red / amber and the chain brand colours are deliberately NOT themed:
 * they mean success, danger, warning and "this is Solana", not "this is the
 * accent".
 *
 * Loaded as a plain script before index.html's babel block; publishes
 * window.chainlensThemes, and exports the same object under node so the port and
 * the ramps can be asserted without a browser (test/theme-engine.test.js).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.chainlensThemes = api;
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var STOPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

  /**
   * Stock Tailwind v3 values, and the un-themed rendering of the app.
   *
   * ⚠ DUPLICATED, on purpose, by the :root block in index.html. That block — not
   * this table — is what the browser paints when no theme is applied, so a
   * failure to load this file leaves Light and Dark looking exactly as they
   * always have instead of stripping every colour out of the page. The two are
   * asserted equal by test/theme-engine.test.js.
   *
   * Here the table is used for the accent's luminance anchors and for the page
   * colour behind stock Light/Dark.
   */
  var STOCK = {
    white: '#ffffff',
    slate: {
      50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1',
      400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155',
      800: '#1e293b', 900: '#0f172a', 950: '#020617'
    },
    blue: {
      50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd',
      400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8',
      800: '#1e40af', 900: '#1e3a8a', 950: '#172554'
    },
    cyan: {
      50: '#ecfeff', 100: '#cffafe', 200: '#a5f3fc', 300: '#67e8f9',
      400: '#22d3ee', 500: '#06b6d4', 600: '#0891b2', 700: '#0e7490',
      800: '#155e75', 900: '#164e63', 950: '#083344'
    }
  };

  // ── Colour maths (port of color.ts) ─────────────────────────────────────────

  function clamp(n, min, max) { return n < min ? min : n > max ? max : n; }
  function clamp255(n) { return clamp(Math.round(n), 0, 255); }
  function normalizeHue(h) { return ((h % 360) + 360) % 360; }

  /** Parse #rgb / #rrggbb, with or without the #. null when it is neither. */
  function parseHex(input) {
    var s = String(input == null ? '' : input).trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(s)) {
      return {
        r: parseInt(s[0] + s[0], 16),
        g: parseInt(s[1] + s[1], 16),
        b: parseInt(s[2] + s[2], 16)
      };
    }
    if (/^[0-9a-fA-F]{6}$/.test(s)) {
      return {
        r: parseInt(s.slice(0, 2), 16),
        g: parseInt(s.slice(2, 4), 16),
        b: parseInt(s.slice(4, 6), 16)
      };
    }
    return null;
  }

  function toHex(c) {
    var pair = function (n) {
      var s = clamp255(n).toString(16);
      return s.length < 2 ? '0' + s : s;
    };
    return '#' + pair(c.r) + pair(c.g) + pair(c.b);
  }

  /** "12 34 56" — the space-separated form Tailwind's <alpha-value> needs. */
  function toRgbSpaced(c) {
    return clamp255(c.r) + ' ' + clamp255(c.g) + ' ' + clamp255(c.b);
  }

  function rgbToHsl(c) {
    var rn = c.r / 255, gn = c.g / 255, bn = c.b / 255;
    var max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    var d = max - min;
    var l = (max + min) / 2;
    var h = 0, s = 0;
    if (d !== 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (max === rn) h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h *= 60;
    }
    return { h: normalizeHue(h), s: clamp(s * 100, 0, 100), l: l * 100 };
  }

  function hslToRgb(hsl) {
    var hn = normalizeHue(hsl.h);
    var sn = clamp(hsl.s, 0, 100) / 100;
    var ln = clamp(hsl.l, 0, 100) / 100;
    var c = (1 - Math.abs(2 * ln - 1)) * sn;
    var x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
    var m = ln - c / 2;
    var t;
    if (hn < 60) t = [c, x, 0];
    else if (hn < 120) t = [x, c, 0];
    else if (hn < 180) t = [0, c, x];
    else if (hn < 240) t = [0, x, c];
    else if (hn < 300) t = [x, 0, c];
    else t = [c, 0, x];
    return { r: (t[0] + m) * 255, g: (t[1] + m) * 255, b: (t[2] + m) * 255 };
  }

  /** Linear blend in sRGB; t = 0 -> a, t = 1 -> b. */
  function mix(a, b, t) {
    var k = clamp(t, 0, 1);
    return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k };
  }

  function shiftLightness(c, delta) {
    var hsl = rgbToHsl(c);
    return hslToRgb({ h: hsl.h, s: hsl.s, l: clamp(hsl.l + delta, 0, 100) });
  }

  function withLightness(c, l) {
    var hsl = rgbToHsl(c);
    return hslToRgb({ h: hsl.h, s: hsl.s, l: clamp(l, 0, 100) });
  }

  /** WCAG relative luminance, 0 (black) … 1 (white). */
  function relativeLuminance(c) {
    var ch = function (v) {
      var s = clamp(v, 0, 255) / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  }

  /** WCAG contrast ratio, 1 … 21. */
  function contrastRatio(a, b) {
    var la = relativeLuminance(a), lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** Light enough that the UI around it has to flip to the light branch. */
  function isLight(c) { return relativeLuminance(c) > 0.35; }

  // ── Derivation (the part of theme-tokens.ts ChainLens renders from) ─────────

  var DEFAULT_COLORS = { bg: '#0a0f1e', accent: '#00aaff', text: '#e8f4ff' };

  var HEX = /^#[0-9a-f]{6}$/i;

  /** Tolerant parse — falls back to the Moonlight-ish default on garbage input. */
  function rgbOf(hex, fallback) {
    return parseHex(hex) || parseHex(fallback) || { r: 0, g: 0, b: 0 };
  }

  /**
   * The seven tokens the palette is built from. The formulas are the wallet's
   * deriveThemeTokens() unchanged, so a theme lands on the same colours in both
   * products; only the emitted variable names differ.
   */
  function derive(colors) {
    var bgDeep = rgbOf(colors && colors.bg, DEFAULT_COLORS.bg);
    var accent = rgbOf(colors && colors.accent, DEFAULT_COLORS.accent);
    var text = rgbOf(colors && colors.text, DEFAULT_COLORS.text);

    var tone = isLight(bgDeep) ? 'light' : 'dark';
    var deepL = rgbToHsl(bgDeep).l;

    // Dark themes stack UP from the page colour; light themes put the PAGE in
    // the middle and lift cards to near-white, which is how White & Gold reads
    // as paper rather than as an inverted dark theme.
    var bgDark = tone === 'dark' ? shiftLightness(bgDeep, 2.7) : shiftLightness(bgDeep, -5.3);
    var bgSurface = tone === 'dark'
      ? shiftLightness(bgDeep, 8.7)
      : withLightness(bgDeep, deepL >= 97 ? 100 : deepL + 4);

    // Blending the text colour into the background (with a hint of accent mixed
    // back) reproduces the shipped themes' secondary/muted greys instead of
    // flattening them to pure grey.
    var textSecondary = mix(mix(text, bgDeep, 0.38), accent, 0.18);
    var textMuted = mix(mix(text, bgDeep, tone === 'dark' ? 0.72 : 0.62), accent, 0.14);

    return {
      tone: tone,
      bgDeep: bgDeep, bgDark: bgDark, bgSurface: bgSurface,
      text: text, textSecondary: textSecondary, textMuted: textMuted,
      accent: accent
    };
  }

  // ── The Tailwind ramps ─────────────────────────────────────────────────────

  /**
   * slate, as a page-background -> primary-text ramp.
   *
   * The stops are anchored, not interpolated end to end, because the app leans
   * on specific ones: 950/900/800 are the page, the card and the raised surface
   * in dark mode; 50/white and 100 are the page and the card in light mode; 400
   * is muted text in BOTH ("text-slate-400 hover:text-slate-500" is written with
   * no ternary at all, so it has to read on either page colour).
   *
   * ⚠ The text tiers are pinned to STOCK CONTRAST, not to the wallet's tokens.
   * Mapping 400/500 straight onto --text-muted/--text-secondary reads correctly
   * in the wallet, where muted text is a garnish, and badly here, where
   * text-slate-400 carries about a hundred labels and descriptions: it landed
   * around 3.5:1 against the page where stock slate-400 gives 7.9:1. The wallet's
   * tokens are still what the ramp is BUILT from — they are just blended towards
   * the text colour until each stop lands near the contrast the markup was
   * written against. Measured per theme in test/theme-engine.test.js.
   */
  function slateRamp(d) {
    if (d.tone === 'dark') {
      return {
        950: d.bgDeep,
        900: d.bgDark,
        800: d.bgSurface,
        700: mix(d.bgSurface, d.textMuted, 0.45),
        600: d.textMuted,
        500: mix(d.textMuted, d.textSecondary, 0.55),
        400: d.textSecondary,
        300: mix(d.textSecondary, d.text, 0.4),
        200: mix(d.textSecondary, d.text, 0.7),
        100: mix(d.textSecondary, d.text, 0.88),
        50: d.text,
        white: d.text
      };
    }
    return {
      50: d.bgDeep,
      100: d.bgDark,
      200: shiftLightness(d.bgDeep, -10),
      300: mix(shiftLightness(d.bgDeep, -16), d.textMuted, 0.25),
      400: d.textMuted,
      500: mix(d.textSecondary, d.text, 0.25),
      600: mix(d.textSecondary, d.text, 0.55),
      700: mix(d.textSecondary, d.text, 0.78),
      800: mix(d.textSecondary, d.text, 0.92),
      900: d.text,
      // A shade past the text colour, the way stock slate-950 sits below 900.
      // Both of its jobs want the extra depth: it is the fill under white text
      // (the active tab pill) and the text on a light accent fill
      // ("bg-cyan-300 text-slate-950"), and a mid-tone text colour — milady's
      // pink — is thin for either until it is darkened.
      950: shiftLightness(d.text, -8),
      // Cards sit ABOVE the page in the light tone, so white is the surface —
      // not the text colour. It is also what text-white lands on over a red or
      // emerald fill, which is why it must stay near-white and never become,
      // say, milady's hot pink.
      white: d.bgSurface
    };
  }

  /**
   * The lightness at which (h, s) has as close as possible to `target` WCAG
   * relative luminance.
   *
   * Luminance is monotonic in HSL lightness for a fixed hue and saturation — L=0
   * is black and L=100 is white whatever the saturation — so a bisection always
   * converges, including on a grey accent, where the whole ramp comes out grey.
   */
  function lightnessForLuminance(h, s, target) {
    var lo = 0, hi = 100;
    for (var i = 0; i < 24; i++) {
      var mid = (lo + hi) / 2;
      if (relativeLuminance(hslToRgb({ h: h, s: s, l: mid })) < target) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /** The accent at each stop's stock luminance — see the header note. */
  function accentRamp(accent, family) {
    var hsl = rgbToHsl(accent);
    var out = {};
    for (var i = 0; i < STOPS.length; i++) {
      var stop = STOPS[i];
      var target = relativeLuminance(parseHex(STOCK[family][stop]));
      out[stop] = hslToRgb({ h: hsl.h, s: hsl.s, l: lightnessForLuminance(hsl.h, hsl.s, target) });
    }
    return out;
  }

  /**
   * The CSS variables for one theme. --cl-page is the colour behind the app —
   * the <body>, which no utility class paints, so overscroll does not flash
   * white under a dark theme.
   */
  function paletteFor(colors) {
    var d = derive(colors);
    var slate = slateRamp(d);
    var blue = accentRamp(d.accent, 'blue');
    var cyan = accentRamp(d.accent, 'cyan');

    var vars = { '--cl-white': toRgbSpaced(slate.white), '--cl-page': toRgbSpaced(d.bgDeep) };
    for (var i = 0; i < STOPS.length; i++) {
      var stop = STOPS[i];
      vars['--cl-slate-' + stop] = toRgbSpaced(slate[stop]);
      vars['--cl-blue-' + stop] = toRgbSpaced(blue[stop]);
      vars['--cl-cyan-' + stop] = toRgbSpaced(cyan[stop]);
    }
    return { tone: d.tone, vars: vars };
  }

  /** [background, accent] for the picker dot. */
  function swatchOf(colors) {
    return [
      toHex(rgbOf(colors && colors.bg, DEFAULT_COLORS.bg)),
      toHex(rgbOf(colors && colors.accent, DEFAULT_COLORS.accent))
    ];
  }

  // ── The shipped themes (builtin-themes.ts THEMES, in picker order) ──────────
  //
  // The wallet renders the first six from hand-tuned CSS blocks and the rest
  // from these same three colours. ChainLens has no such blocks, so all twelve
  // are derived — which is why `colors` for the first six must stay the
  // [--bg-deep, --accent, --text-primary] of their blocks in the wallet's
  // index.css. Drift there is what makes one theme look like two.
  var BUILTIN_THEMES = [
    { id: 'moonlight',   name: 'Moonlight',    colors: { bg: '#060b18', accent: '#00aaff', text: '#e8f4ff' } },
    { id: 'crimson',     name: 'Crimson',      colors: { bg: '#18060a', accent: '#ff3355', text: '#ffe8ec' } },
    { id: 'grape',       name: 'Grape',        colors: { bg: '#0d0618', accent: '#a24dff', text: '#f2e8ff' } },
    { id: 'matrix',      name: 'Matrix',       colors: { bg: '#000000', accent: '#00ff41', text: '#ccffd6' } },
    { id: 'white-gold',  name: 'White & Gold', colors: { bg: '#f6f2ea', accent: '#c9a227', text: '#3a3325' } },
    { id: 'midnight',    name: 'Midnight',     colors: { bg: '#000000', accent: '#ffffff', text: '#f5f5f5' } },
    { id: 'cardano',     name: 'Cardano',      colors: { bg: '#03091a', accent: '#0033ad', text: '#ffffff' } },
    { id: 'milady',      name: 'milady',       colors: { bg: '#ffeaf8', accent: '#ff4b97', text: '#ff4b97' } },
    { id: 'monad',       name: 'Monad',        colors: { bg: '#140529', accent: '#6e54ff', text: '#85e6ff' } },
    { id: 'abstract',    name: 'Abstract',     colors: { bg: '#ffffff', accent: '#52f293', text: '#000000' } },
    { id: 'bitcoin',     name: 'Bitcoin',      colors: { bg: '#000000', accent: '#f2a900', text: '#ababab' } },
    { id: 'sappy-seals', name: 'Sappy Seals',  colors: { bg: '#ffffff', accent: '#000000', text: '#000000' } }
  ];

  var BUILTIN_BY_ID = {};
  BUILTIN_THEMES.forEach(function (theme) { BUILTIN_BY_ID[theme.id] = theme; });

  // ── The cl_themes wire (theme-sync-wire.ts) ────────────────────────────────
  //
  // ChainLens only ever READS this map, so the merge, the prune and the writing
  // of tombstones stay in the wallet. What is ported is the part that decides
  // what a valid entry IS, because a theme this parser rejects is a theme that
  // silently never appears — the exact failure the wallet's frozen-wire note is
  // about.

  var MAX_SYNCED_THEMES = 6;
  var THEME_ID_MAX = 64;
  var THEME_NAME_MAX = 24;
  var MAX_THEME_ENTRIES = 64;

  function cleanHex(value) {
    if (typeof value !== 'string') return null;
    var s = value.trim();
    return HEX.test(s) ? s.toLowerCase() : null;
  }

  function sanitizeEntries(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    var out = {};
    var seen = 0;
    var ids = Object.keys(value);
    for (var i = 0; i < ids.length; i++) {
      if (seen >= MAX_THEME_ENTRIES) break;
      var id = ids[i];
      var raw = value[id];
      if (!id || id.length > THEME_ID_MAX || id.indexOf('custom-') !== 0) continue;
      if (!raw || typeof raw !== 'object') continue;
      // typeof first: Number(null) is 0, which is finite and non-negative, so a
      // null timestamp would sail through as "the oldest possible entry".
      var t = raw.t;
      if (typeof t !== 'number' || !isFinite(t) || t < 0) continue;

      if (raw.d === 1) {
        // A tombstone carries no colours — keep it as small as it is.
        out[id] = { n: '', c: { bg: '', accent: '', text: '' }, t: t, d: 1 };
        seen++;
        continue;
      }

      var bg = cleanHex(raw.c && raw.c.bg);
      var accent = cleanHex(raw.c && raw.c.accent);
      var text = cleanHex(raw.c && raw.c.text);
      if (!bg || !accent || !text) continue;
      out[id] = {
        n: (typeof raw.n === 'string' ? raw.n : '').trim().slice(0, THEME_NAME_MAX) || 'Custom',
        c: { bg: bg, accent: accent, text: text },
        t: t
      };
      seen++;
    }
    return out;
  }

  /**
   * The live (non-tombstoned) themes, newest first, capped the way the wallet's
   * own picker caps them — so both products show the same six.
   */
  function liveThemes(entries) {
    var clean = sanitizeEntries(entries);
    return Object.keys(clean)
      .filter(function (id) { return clean[id].d !== 1; })
      .map(function (id) {
        return { id: id, name: clean[id].n, colors: clean[id].c, t: clean[id].t };
      })
      .sort(function (a, b) { return b.t - a.t; })
      .slice(0, MAX_SYNCED_THEMES);
  }

  // ── Applying ───────────────────────────────────────────────────────────────

  var VAR_NAMES = (function () {
    var names = ['--cl-white', '--cl-page'];
    STOPS.forEach(function (stop) {
      names.push('--cl-slate-' + stop, '--cl-blue-' + stop, '--cl-cyan-' + stop);
    });
    return names;
  })();

  /**
   * Wear a theme. Returns its tone, which is what the app's `darkMode` boolean
   * has to follow: the utility classes still branch on it, and a light theme
   * rendered through the dark branch would put the page colour where the text
   * colour belongs.
   */
  function applyTheme(colors) {
    var palette = paletteFor(colors);
    var root = document.documentElement;
    Object.keys(palette.vars).forEach(function (name) {
      root.style.setProperty(name, palette.vars[name]);
    });
    root.setAttribute('data-cl-tone', palette.tone);
    return palette.tone;
  }

  /**
   * Back to stock Light or Dark. Every variable is REMOVED rather than set to
   * its stock value, so the :root block in index.html is what renders again —
   * one definition of "un-themed", not two that can drift.
   */
  function applyMode(mode) {
    var root = document.documentElement;
    VAR_NAMES.forEach(function (name) { root.style.removeProperty(name); });
    root.setAttribute('data-cl-tone', mode === 'dark' ? 'dark' : 'light');
    // --cl-page is the one exception: the :root default is the light page, so
    // stock Dark still has to say which end of the ramp it sits at.
    root.style.setProperty('--cl-page',
      toRgbSpaced(parseHex(mode === 'dark' ? STOCK.slate[950] : STOCK.slate[50])));
  }

  return {
    STOCK: STOCK,
    STOPS: STOPS,
    BUILTIN_THEMES: BUILTIN_THEMES,
    MAX_SYNCED_THEMES: MAX_SYNCED_THEMES,
    builtinById: function (id) { return BUILTIN_BY_ID[id] || null; },
    parseHex: parseHex,
    toHex: toHex,
    toRgbSpaced: toRgbSpaced,
    relativeLuminance: relativeLuminance,
    contrastRatio: contrastRatio,
    isLight: isLight,
    derive: derive,
    paletteFor: paletteFor,
    swatchOf: swatchOf,
    sanitizeEntries: sanitizeEntries,
    liveThemes: liveThemes,
    applyTheme: applyTheme,
    applyMode: applyMode
  };
}));
