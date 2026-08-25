# ChainLens — Design Document

> **Multi-Chain Portfolio Scanner & Explorer**
> A single-page web application for scanning NFTs, tokens, and transactions across 23 blockchains.

---

## 1. Overview

ChainLens lets users connect a detected browser wallet or manually link a public address for seven wallet families covering 23 chains: EVM, Solana, Polkadot, Tron, Cardano, Bitcoin, and Dogecoin. Magic Money Wallet participates through the same provider standards as other extensions, so its addresses attach to the user's existing ChainLens profile. Scanner inputs remain grouped by address family: EVM, account-model (Solana/Polkadot/Tron), and UTXO/eUTXO (Cardano/Bitcoin/Dogecoin).

The design language is bold, minimal, and web3-native: oversized rounded corners, glassmorphism cards, chain-specific gradient accents, and a clean dark/light dual theme.

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 (UMD CDN), Babel standalone |
| Styling | Tailwind CSS (CDN) + custom CSS |
| Charts | Chart.js 4.4 |
| Backend | Node.js + Express |
| Database | Supabase (optional — profile/auth features) |
| Auth | JWT + wallet-signed nonces |
| Hosting | Static `public/` served by Express on port 10000 |

---

## 3. Typography

| Role | Font | Weights |
|---|---|---|
| Body / UI | Space Grotesk | 300, 400, 500, 700 |
| Headings / Wordmarks | Syne | 700, 800 |

**Usage conventions:**
- `font-heading` (Syne) is used for asset names, section titles, large numeric displays, and the nav logo.
- `font-sans` (Space Grotesk) is used for all body copy, labels, metadata, and UI controls.
- Labels use `uppercase tracking-widest text-[9px]–text-xs font-black` for a consistent badge/pill style.

---

## 4. Color System

### Brand Gradients

```css
/* Solana / primary accent */
.bg-solana-gradient       { background: linear-gradient(45deg, #9945FF, #14F195); }
.bg-solana-gradient-soft  { background: linear-gradient(45deg, rgba(153,69,255,0.85), rgba(20,241,149,0.85)); }
```

### Chain Pill Colors

| Chain | Gradient / Color |
|---|---|
| EVM (Ethereum, etc.) | `linear-gradient(135deg, #627EEA, #3c3c3d)` |
| Solana | `linear-gradient(135deg, #9945FF, #14F195)` |
| Cardano | `linear-gradient(135deg, #0033AD, #00BAFF)` |

Chain pills appear as small `uppercase tracking-widest` badge overlays on asset cards, colored by chain.

### UI Palette (Tailwind)

`slate`, `blue`, `cyan` and `white` are declared as CSS variables so a MagicMoney
theme can recolour them (see §9); the values below are the stock defaults, and
the roles below are what a theme re-maps.

| Role | Dark Mode | Light Mode |
|---|---|---|
| Page background | `slate-950` / `slate-900` | `white` / `slate-50` |
| Card surface | `slate-900` / `slate-800` | `white` |
| Card border | `slate-800` / `slate-700` | `slate-100` / `slate-200` |
| Primary accent | `emerald-500` / `emerald-400` | `emerald-500` |
| Secondary accent | `blue-600` / `blue-400` | `blue-600` |
| Destructive / spam | `red-500` / `red-600` | same |
| Muted text | `slate-500` / `slate-600` | `slate-400` |
| Body text | `white` | `slate-900` |

### Semantic Color Usage

- **Emerald** — positive actions (connect wallet, confirm, add, value gain).
- **Blue** — navigation, asset detail actions, scanning states.
- **Orange** — detected browser wallet buttons (hover state).
- **Red** — spam marking, destructive actions, close buttons (hover).
- **Purple → Green gradient** — Solana branding, primary CTAs.

---

## 5. Spacing & Shape

ChainLens uses an intentionally generous border-radius scale to feel modern and approachable:

| Element | Border Radius |
|---|---|
| Asset cards | `rounded-[2.5rem]` (40px) |
| Modals / overlays | `rounded-[3.5rem]` (56px) |
| Wallet picker rows | `rounded-2xl` (16px) |
| Swap column container | `rounded-[2rem]` (32px) |
| Pills / badges | `rounded-full` |
| Icon buttons | `rounded-full` or `rounded-xl` |
| Input fields | `rounded-2xl` |

Padding tends to be generous: cards use `p-5` to `p-12`, modals `p-6 md:p-12`.

---

## 6. Component Patterns

### Glass Card

```css
.glass-card {
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}
```

Used on overlapping modals and stat panels to create depth without full opacity.

### Asset Card (Grid vs List)

- **Grid view** — `aspect-square` image, centered text, `hover:-translate-y-2 hover:shadow-xl` lift effect on light mode.
- **List view** — `flex` row, 64×64 thumbnail, name + symbol left, balance/value right.
- Both show chain pill badge, hide/spam action buttons on hover (opacity 0 → 100 transition).

### Chain Pills

Inline badge overlays: `absolute top-4 left-4`, `text-[9px] font-bold uppercase tracking-widest backdrop-blur-md border border-white/20`.

### Toggle Switch

Custom CSS switch (48×24px) with springy cubic-bezier dot transition (`cubic-bezier(0.68, -0.55, 0.265, 1.55)`). Used for dark mode and view toggles.

### Modals

Full-screen backdrop (`bg-slate-950/95 backdrop-blur-xl`) with `fadeIn` animation. Content panel uses `.modal-enter`. Close button uses `rounded-full bg-slate-800 hover:bg-red-500` pattern.

### Wallet Picker

One shared sheet-style modal is configured by wallet family. It always offers manual public-address linking and lists every compatible provider discovered from the browser instead of maintaining a handpicked wallet list. Discovery uses EIP-6963/`window.ethereum` for EVM, Wallet Standard/legacy providers for Solana, CIP-30 `window.cardano` for Cardano, WBIP-compatible Bitcoin providers, `window.injectedWeb3` for Polkadot, and available injected Tron/Dogecoin providers. Magic Money is identified in the list when its provider is present.

Rows use `border` + `hover:border-{color}` + `hover:bg-{color}/5` for a subtle highlight without background flash.

---

## 7. Animations

| Class / Keyframe | Usage |
|---|---|
| `slideUp` (0.4s ease-out, staggered `0s / 0.08s / 0.16s / 0.24s`) | Profile page section entrance |
| `fadeIn` (0.3s ease-out) | Modal entrance |
| `pulse-slow` (3s, custom) | Scanning / loading indicators |
| `hover:-translate-y-2` | Social link buttons, light-mode cards |
| `hover:translateY(-1px)` | Wallet cards |
| `group-hover:scale-110` | Asset card image zoom (700ms) |
| `transition-all 0.4s cubic-bezier(0.4,0,0.2,1)` | Switch background |
| `transition-all 0.4s cubic-bezier(0.68,-0.55,0.265,1.55)` | Switch dot (spring) |

---

## 8. Layout & Navigation

The app is a single-page React app rooted at `#root`. Navigation is a horizontally scrollable tab bar (`.scrollbar-none` on mobile) with four primary tabs:

| Tab | Icon | Content |
|---|---|---|
| Portfolio | 🏠 | NFT/token grid for connected wallets |
| Market | 📊 | Top 100 coins + price charts |
| Swap | 🔄 | Embedded DEX iframes |
| Profile | 👤 | Auth, linked wallets, settings |

Max content width: `max-w-6xl mx-auto` for the asset grid; wider for market/profile panels.

### Responsive Behavior

- Asset grid: `grid-cols-2 md:grid-cols-4 lg:grid-cols-5`
- Mobile: `overflow-x: hidden` on body; tab nav scrollable
- Swap column: fixed `650px` height, `min-height: 600px`, scales with container width

---

## 9. Theming

Light and dark are controlled by a `darkMode` boolean in React state (persisted to `localStorage`). All components pass `darkMode` as a prop and use conditional Tailwind classes inline — no `dark:` prefix variant.

**Toggle location:** Top-right of the navbar, custom animated switch.

### MagicMoney themes

Signed-in accounts that can also use Messenger — a verified (non-watch-only)
wallet **and** a linked Google or Discord account — get the twelve themes
MagicMoney Wallet ships plus any custom themes the wallet has synced to the
ChainLens profile. Everyone else keeps the light/dark switch, unchanged.

Because nothing in the app reads a design token, a theme is applied by
**recolouring the Tailwind palette itself**. `index.html` declares `slate`,
`blue`, `cyan` and `white` as `rgb(var(--cl-…) / <alpha-value>)`, and
`public/theme-engine.js` writes new values for those variables on `<html>`. Every
existing class keeps working, alpha modifiers and gradients included:

| Family | Themed as |
|---|---|
| `slate` | A page-background → primary-text ramp; the theme's tone decides which end is which, and `darkMode` follows that tone |
| `white` | Primary text in a dark theme, the card surface in a light one |
| `blue`, `cyan` | The theme's accent hue and saturation at each stop's **stock relative luminance**, so `bg-cyan-500 text-slate-950` and `bg-blue-600 text-white` stay readable for any accent |
| `emerald`, `red`, `amber`, chain pills | Not themed — they mean success, danger, warning and "this is Solana" |

`theme-engine.js` is a hand-kept port of the wallet's `color.ts`,
`theme-tokens.ts`, `builtin-themes.ts` and `theme-sync-wire.ts` (same
arrangement as `public/asset-filter-key.js`). The stock palette is duplicated in
`index.html`'s `:root` block so a failed script load leaves light and dark
looking exactly as they always have; `test/theme-engine.test.js` asserts the two
copies match, and holds the ramps to the contrast the markup was written against.

Themes are **read-only here** — they are created and edited in MagicMoney Wallet,
and which one ChainLens wears is a per-install choice that never travels back.

---

## 10. Supported Blockchains

| Category | Chains |
|---|---|
| EVM | Ethereum, Arbitrum One, Optimism, Base, Polygon, Avalanche, Blast, Gnosis, Monad, Abstract, ApeChain, Robinhood Chain, Ronin, Soneium, WorldChain, Zora, HyperEVM |
| Account model | Solana, Polkadot, Tron |
| UTXO / eUTXO | Cardano, Bitcoin, Dogecoin |

---

## 11. External APIs & Services

| Service | Purpose |
|---|---|
| **Alchemy** | EVM NFTs, tokens, transaction history |
| **Helius** | Solana NFTs, tokens, transactions |
| **Blockfrost** | Cardano balances and transactions |
| **mempool.space / Blockstream** | Bitcoin balances and transactions |
| **Polkadot RPC / Subscan** | DOT balances; transaction history when optional `SUBSCAN_API_KEY` is configured |
| **TronGrid** | TRX balances and transactions |
| **BlockCypher / Dogechain** | DOGE balances and transactions |
| **Moralis** | Monad transaction history |
| **CoinGecko** | Native token prices (90s cache) |
| **DexScreener** | Token pair prices |
| **Zerion** | Supplemental EVM token data |
| **Unstoppable Domains** | ENS / UD domain resolution |
| **Jupiter API** | Solana swap widget |
| **Uniswap API** | EVM swap widget |
| **DexHunter** | Cardano swap widget |
| **Supabase** | User profiles, linked wallets, auth records |
| **GIPHY** | Trending/search GIFs in World Chat and direct messages (`GIPHY_API_KEY`) |

---

## 12. Authentication Flow

1. User initiates connection (detected EVM, Solana, or Cardano signer; Google/Discord; or a manual public address).
2. Frontend requests a nonce from `/api/auth/nonce`.
3. User signs the message `ChainLens login\nAddress: {addr}\nNonce: {nonce}` in their wallet.
4. Backend verifies the signature (ethers.js for EVM, tweetnacl for Solana, CBOR for Cardano) and returns a JWT.
5. JWT stored in `localStorage` as `cl_token`; passed as `Authorization: Bearer` header on all protected routes.

**Watch-only wallets:** Any of the seven wallet families can be linked by typing a valid public address. Bitcoin, Polkadot, Tron, and Dogecoin extension connections also link the returned public address as watch-only because they are not login authorities. Server-side family validation rejects malformed addresses; no private keys or seed phrases are requested or stored.

**Social OAuth:** Google and Discord OAuth redirect flows, backed by `cl_linked_accounts` in Supabase. Accounts are merged by `provider + provider_id`.

---

## 13. Data Storage

### Supabase Tables

| Table | Purpose |
|---|---|
| `cl_users` | User records (provider, display_name, avatar_url) |
| `cl_wallets` | Linked wallet addresses per user (chain, address, is_primary) |
| `cl_linked_accounts` | Social OAuth accounts linked to a user |
| `cl_friendships` | Pending/accepted friend relationships keyed by ChainLens user IDs |
| `cl_world_messages` | World Chat text and GIPHY messages |
| `cl_direct_messages` | Messages scoped to an accepted friendship |
| `cl_themes` | Custom themes built in MagicMoney Wallet, one row per account |

### Messenger setup

Run `sql/cl_chat.sql` once against the Supabase project and configure a public
GIPHY integration key as `GIPHY_API_KEY`. Messenger requires the signed-in
profile to have at least one verified (non-watch-only) wallet and at least one
linked Google or Discord account. Friend requests use the full `cl_users.id`
UUID shown beneath the profile name; direct messages unlock only after the
recipient accepts. Users can delete only messages they authored. Text links are
blocked in World Chat and rendered as clickable links only in direct messages;
GIPHY remains available in both scopes and returns up to 30 results per search.
The frontend polls cursor-based message endpoints and periodically reconciles
deletions, while the Express server owns authorization and is the only caller
allowed to access the RLS-protected chat tables.

### Themes setup

Run `sql/cl_themes.sql` once against the Supabase project. Until it exists,
`GET /api/profile/themes` reads as "no custom themes" rather than failing, so the
twelve built-ins still work — they are client-side. The table is written only by
MagicMoney Wallet, through its Cloudflare Worker; ChainLens reads it with the
service key and never writes. The route is gated on the same eligibility as
Messenger and answers `200 { eligible: false, entries: {} }` rather than a 403,
because the client draws the whole picker from that one reply.

### localStorage (client-side)

| Key | Content |
|---|---|
| `cl_token` | JWT auth token |
| `cl_theme` | Chosen theme id — `light`, `dark`, a MagicMoney theme, or a `custom-…` synced one |
| `darkMode` | Whether the current theme's tone is dark; also the fallback when a theme cannot be worn |
| `hiddenAssets` | JSON array of asset IDs hidden by user |
| `spamAssets` | JSON array of asset IDs marked as spam |

---

## 14. Branding Assets

| File | Usage |
|---|---|
| `ChainLens_dark_.png` | Full wordmark — for dark backgrounds |
| `ChainLens_light_.png` | Full wordmark — for light backgrounds |
| `chainlens_icon_dark.png` | Square icon — dark variant (favicon, app icon) |
| `chainlens_icon_light.png` | Square icon — light variant |

The icon is a chain link combined with a magnifying glass, rendered in a bold, high-contrast monochrome style.

---

## 15. Scrollbar Styling

Custom dark scrollbars applied via `.dark-scroll`:

```css
.dark-scroll::-webkit-scrollbar       { width: 8px; }
.dark-scroll::-webkit-scrollbar-track { background: #0f172a; }
.dark-scroll::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
```

Tab navigation uses `.scrollbar-none` to hide the scrollbar on mobile.

---

## 16. Key UX Decisions

- **No page reloads** — all state managed in React; wallet connections and scans update the UI inline.
- **Abort on re-scan** — an `AbortController` ref cancels in-flight fetch requests when the user triggers a new scan, preventing stale data races.
- **Address-family routing** — comma-separated inputs are detected locally and sent only to the matching chain adapter; EVM addresses remain isolated from non-EVM lookups.
- **Asset deduplication** — NFTs and tokens are keyed by `{chain}-{address/id}` to prevent duplicates across multi-wallet loads.
- **Spam/hide management** — Users can hide or flag spam assets per-session (localStorage); a management modal lets them review and restore hidden items.
- **Image fallback** — All asset images use an `onError` handler that falls back to an inline SVG placeholder generated from the asset symbol and chain color.
- **Price display** — Token cards show balance, native-denominated value, and USD value. USD values are computed from CoinGecko native prices fetched at scan time.
