const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const themes = require('../public/theme-engine');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** The `--cl-*: r g b;` declarations from index.html's :root block. */
const rootVars = (() => {
  const block = INDEX_HTML.match(/:root\s*\{([\s\S]*?)\}/);
  assert.ok(block, 'index.html has no :root block declaring the palette');
  const out = {};
  for (const [, name, value] of block[1].matchAll(/(--cl-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim();
  }
  return out;
})();

const spaced = (hex) => themes.toRgbSpaced(themes.parseHex(hex));
const rgb = (triplet) => {
  const [r, g, b] = triplet.split(/\s+/).map(Number);
  return { r, g, b };
};
const ratio = (a, b) => themes.contrastRatio(rgb(a), rgb(b));

/** Every variable a theme sets, which is also every one :root has to declare. */
const paletteVarNames = Object.keys(themes.paletteFor(themes.BUILTIN_THEMES[0].colors).vars);

// ── The un-themed palette ────────────────────────────────────────────────────
//
// index.html's :root block is what renders when no theme is worn, and the engine
// keeps its own copy of the same table for the accent's luminance anchors. These
// two tests are the only thing standing between that duplication and a silent
// drift, so they compare it stop for stop.

test('the :root block declares exactly the variables a theme overrides', () => {
  assert.deepEqual(Object.keys(rootVars).sort(), [...paletteVarNames].sort());
});

test('the :root block holds stock Tailwind values', () => {
  assert.equal(rootVars['--cl-white'], spaced(themes.STOCK.white));
  // The page default is the LIGHT page; stock Dark says so explicitly by
  // setting --cl-page, which is why the default is not the dark one.
  assert.equal(rootVars['--cl-page'], spaced(themes.STOCK.slate[50]));
  for (const family of ['slate', 'blue', 'cyan']) {
    for (const stop of themes.STOPS) {
      assert.equal(
        rootVars[`--cl-${family}-${stop}`], spaced(themes.STOCK[family][stop]),
        `--cl-${family}-${stop} drifted from stock Tailwind`
      );
    }
  }
});

// ── The shipped themes ───────────────────────────────────────────────────────

test('the twelve MagicMoney themes are present, unique, and well formed', () => {
  assert.equal(themes.BUILTIN_THEMES.length, 12);
  const ids = themes.BUILTIN_THEMES.map(theme => theme.id);
  assert.equal(new Set(ids).size, 12);
  for (const theme of themes.BUILTIN_THEMES) {
    assert.ok(theme.name, `${theme.id} has no name`);
    for (const key of ['bg', 'accent', 'text']) {
      assert.match(theme.colors[key], /^#[0-9a-f]{6}$/, `${theme.id}.${key} is not #rrggbb`);
    }
    assert.equal(themes.builtinById(theme.id), theme);
  }
  assert.equal(themes.builtinById('no-such-theme'), null);
  // The custom-theme namespace must never collide with a shipped id, or a synced
  // theme would shadow one of these.
  assert.ok(ids.every(id => !id.startsWith('custom-')));
});

test('a theme paints its own background as the page, at either tone', () => {
  for (const theme of themes.BUILTIN_THEMES) {
    const { tone, vars } = themes.paletteFor(theme.colors);
    const page = tone === 'dark' ? vars['--cl-slate-950'] : vars['--cl-slate-50'];
    assert.equal(page, spaced(theme.colors.bg), `${theme.id} does not use its own bg as the page`);
    assert.equal(vars['--cl-page'], spaced(theme.colors.bg), `${theme.id} leaves <body> off-theme`);
  }
});

test('every variable is a space-separated triplet Tailwind can take an alpha of', () => {
  for (const theme of themes.BUILTIN_THEMES) {
    for (const [name, value] of Object.entries(themes.paletteFor(theme.colors).vars)) {
      assert.match(value, /^\d{1,3} \d{1,3} \d{1,3}$/, `${theme.id} ${name} = "${value}"`);
      // Commas here would make every rgb(var(--x) / <alpha>) invalid at once.
      assert.ok(!value.includes(','), `${theme.id} ${name} is comma-separated`);
    }
  }
});

test('the dark tone stacks page -> card -> surface, lightening each step', () => {
  for (const theme of themes.BUILTIN_THEMES) {
    const { tone, vars } = themes.paletteFor(theme.colors);
    if (tone !== 'dark') continue;
    const lum = (name) => themes.relativeLuminance(rgb(vars[name]));
    assert.ok(lum('--cl-slate-900') >= lum('--cl-slate-950'), `${theme.id} card is darker than the page`);
    assert.ok(lum('--cl-slate-800') >= lum('--cl-slate-900'), `${theme.id} surface is darker than the card`);
  }
});

test('the light tone lifts cards above the page', () => {
  for (const theme of themes.BUILTIN_THEMES) {
    const { tone, vars } = themes.paletteFor(theme.colors);
    if (tone !== 'light') continue;
    const lum = (name) => themes.relativeLuminance(rgb(vars[name]));
    assert.ok(lum('--cl-white') >= lum('--cl-slate-50'), `${theme.id} cards are darker than the page`);
    assert.ok(lum('--cl-slate-50') >= lum('--cl-slate-100'), `${theme.id} page is darker than slate-100`);
  }
});

// ── The accent ramps ─────────────────────────────────────────────────────────

test('blue and cyan hold each stop at its stock luminance', () => {
  // This is what keeps "bg-cyan-500 text-slate-950" and "bg-blue-600 text-white"
  // readable for an accent of any hue: the markup chose those stops for their
  // brightness, and the brightness is what does not move.
  for (const theme of themes.BUILTIN_THEMES) {
    const { vars } = themes.paletteFor(theme.colors);
    for (const family of ['blue', 'cyan']) {
      for (const stop of themes.STOPS) {
        const want = themes.relativeLuminance(themes.parseHex(themes.STOCK[family][stop]));
        const got = themes.relativeLuminance(rgb(vars[`--cl-${family}-${stop}`]));
        assert.ok(
          Math.abs(got - want) < 0.01,
          `${theme.id} ${family}-${stop}: luminance ${got.toFixed(3)} vs stock ${want.toFixed(3)}`
        );
      }
    }
  }
});

test('an achromatic accent gives a grey ramp rather than diverging', () => {
  // Midnight's accent is #ffffff and Sappy Seals' is #000000. The bisection has
  // to land on a grey at every stop, not run to an endpoint.
  for (const id of ['midnight', 'sappy-seals']) {
    const { vars } = themes.paletteFor(themes.builtinById(id).colors);
    for (const stop of themes.STOPS) {
      const { r, g, b } = rgb(vars[`--cl-cyan-${stop}`]);
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 1, `${id} cyan-${stop} is not grey`);
    }
  }
});

// ── The text ramp ────────────────────────────────────────────────────────────

test('text tiers get steadily stronger against the page', () => {
  // The markup reads the slate scale as an ordering — text-slate-400 is dimmer
  // than text-slate-500 is dimmer than the primary — and every ternary in the
  // app is written against that. A theme may be quiet or loud; it may not
  // scramble the order.
  const rising = [400, 500, 600, 700, 800, 900];
  for (const theme of themes.BUILTIN_THEMES) {
    const { tone, vars } = themes.paletteFor(theme.colors);
    const page = vars[tone === 'dark' ? '--cl-slate-950' : '--cl-slate-50'];
    // Dark mode runs the other way: 900 is the card, 50 is the text.
    const order = tone === 'dark' ? [...rising].reverse() : rising;
    let previous = 0;
    for (const stop of order) {
      const current = ratio(vars[`--cl-slate-${stop}`], page);
      assert.ok(
        current >= previous - 0.02,
        `${theme.id} slate-${stop} (${current.toFixed(2)}) breaks the ramp after ${previous.toFixed(2)}`
      );
      previous = current;
    }
  }
});

test('muted text stays close to the contrast the markup was written against', () => {
  // Stock gives slate-400 7.9:1 on the dark page and 2.5:1 on the light one, and
  // roughly a hundred labels are set in it. A theme whose OWN text/background
  // pairing is readable has to keep those labels readable too.
  //
  // milady is exempt by construction: hot pink on pale pink is 2.7:1 before any
  // of this runs, so no mapping can make text drawn from it read better than
  // that. The bar is the theme's own contrast, not an absolute.
  for (const theme of themes.BUILTIN_THEMES) {
    const { tone, vars } = themes.paletteFor(theme.colors);
    const own = themes.contrastRatio(
      themes.parseHex(theme.colors.text), themes.parseHex(theme.colors.bg)
    );
    if (own < 7) {
      assert.equal(theme.id, 'milady', `${theme.id} is a new low-contrast theme — check the ramp`);
      continue;
    }
    const page = vars[tone === 'dark' ? '--cl-slate-950' : '--cl-slate-50'];
    const floor = tone === 'dark' ? 4.5 : 2;
    assert.ok(
      ratio(vars['--cl-slate-400'], page) >= floor,
      `${theme.id} slate-400 is ${ratio(vars['--cl-slate-400'], page).toFixed(2)}:1, under ${floor}`
    );
    assert.ok(
      ratio(vars['--cl-slate-500'], page) >= 3,
      `${theme.id} slate-500 is ${ratio(vars['--cl-slate-500'], page).toFixed(2)}:1, under 3`
    );
  }
});

// ── The cl_themes wire ───────────────────────────────────────────────────────
//
// Rejecting an entry here is indistinguishable, to the user, from the wallet
// never having synced it — so these assert the exact shape the wallet writes.

const entry = (over = {}) => ({
  n: 'Cherry', c: { bg: '#2a0512', accent: '#ff2d6f', text: '#ffe3ee' }, t: 1755000000000, ...over,
});

test('sanitizeEntries keeps a well-formed custom theme, lowercased', () => {
  const clean = themes.sanitizeEntries({
    'custom-1': entry({ c: { bg: '#2A0512', accent: '#FF2D6F', text: '#FFE3EE' } }),
  });
  assert.deepEqual(clean, {
    'custom-1': { n: 'Cherry', c: { bg: '#2a0512', accent: '#ff2d6f', text: '#ffe3ee' }, t: 1755000000000 },
  });
});

test('sanitizeEntries drops anything the wallet could not have written', () => {
  const clean = themes.sanitizeEntries({
    'moonlight': entry(),                                  // not a custom- id
    ['custom-' + 'x'.repeat(80)]: entry(),                 // over THEME_ID_MAX
    'custom-nan': entry({ t: Number.NaN }),
    'custom-null-t': entry({ t: null }),                   // Number(null) is 0 — must not pass
    'custom-negative': entry({ t: -1 }),
    'custom-short-hex': entry({ c: { bg: '#fff', accent: '#ff2d6f', text: '#ffe3ee' } }),
    'custom-missing': entry({ c: { bg: '#2a0512', accent: '#ff2d6f' } }),
    'custom-not-object': 'nope',
    'custom-ok': entry(),
  });
  assert.deepEqual(Object.keys(clean), ['custom-ok']);
  assert.deepEqual(themes.sanitizeEntries(null), {});
  assert.deepEqual(themes.sanitizeEntries([entry()]), {});
});

test('sanitizeEntries trims a long name and names an unnamed theme', () => {
  const clean = themes.sanitizeEntries({
    'custom-long': entry({ n: 'x'.repeat(40) }),
    'custom-blank': entry({ n: '   ' }),
  });
  assert.equal(clean['custom-long'].n.length, 24);
  assert.equal(clean['custom-blank'].n, 'Custom');
});

test('sanitizeEntries keeps a tombstone, colours and all stripped', () => {
  // t = 0 is legal (migrated pre-sync themes use it) and must survive.
  const clean = themes.sanitizeEntries({ 'custom-gone': { t: 0, d: 1 } });
  assert.deepEqual(clean['custom-gone'], { n: '', c: { bg: '', accent: '', text: '' }, t: 0, d: 1 });
});

test('liveThemes hides tombstones, sorts newest first, and caps at the wallet limit', () => {
  const entries = { 'custom-dead': entry({ t: 9e12, d: 1 }) };
  for (let i = 0; i < 9; i++) entries[`custom-${i}`] = entry({ n: `T${i}`, t: 1000 + i });

  const live = themes.liveThemes(entries);
  assert.equal(live.length, themes.MAX_SYNCED_THEMES);
  assert.ok(!live.some(theme => theme.id === 'custom-dead'));
  assert.deepEqual(live.map(theme => theme.name), ['T8', 'T7', 'T6', 'T5', 'T4', 'T3']);
  assert.deepEqual(live[0].colors, entry().c);
});

test('a synced theme renders through the same palette as a shipped one', () => {
  const [live] = themes.liveThemes({ 'custom-cherry': entry() });
  const { tone, vars } = themes.paletteFor(live.colors);
  assert.equal(tone, 'dark');
  assert.equal(vars['--cl-slate-950'], spaced('#2a0512'));
  assert.equal(vars['--cl-white'], spaced('#ffe3ee'));
});

test('swatchOf reports background then accent, and survives junk', () => {
  assert.deepEqual(themes.swatchOf({ bg: '#2A0512', accent: '#ff2d6f', text: '#ffe3ee' }),
    ['#2a0512', '#ff2d6f']);
  // A picker dot must still draw something for a theme that somehow got past
  // the parser, rather than throwing mid-render.
  assert.deepEqual(themes.swatchOf({}), ['#0a0f1e', '#00aaff']);
});
