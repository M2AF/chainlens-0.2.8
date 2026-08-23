-- ═══════════════════════════════════════════════════════════════════════════
-- cl_themes — the custom themes a ChainLens account has built
--
-- Run once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to re-run: every statement is IF NOT EXISTS / OR REPLACE.
--
-- Until this table exists, the Worker's reader treats it as "no themes" and the
-- writer fails quietly, so the wallet keeps using its local themes exactly as it
-- did before syncing existed. Deploying the Worker before running this is fine —
-- nothing breaks, sync just does nothing.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.cl_themes (
  -- One row per account: the whole set is a single document, because it is only
  -- ever read and written whole, and it is capped at a handful of themes.
  user_id    uuid primary key references public.cl_users(id) on delete cascade,

  -- { "custom-<id>": { "n": "<name>", "c": { "bg": "#rrggbb",
  --                                          "accent": "#rrggbb",
  --                                          "text": "#rrggbb" },
  --                    "t": <epoch ms>, "d": 1? } }
  --
  --   n = display name (<= 24 chars)
  --   c = the three colours the user controls; every other design token in the
  --       wallet is derived from them (src/renderer/lib/theme-tokens.ts)
  --   t = when the theme last changed, which is what makes concurrent edits from
  --       two devices converge (newest wins, per id)
  --   d = 1 means DELETED
  --
  -- 'd' is a TOMBSTONE, not an absence. Deleting a theme has to out-rank the copy
  -- another device still holds; dropping the key instead would let that device
  -- re-create the theme on its next push, and it would never stay deleted.
  --
  -- The shape is a wire contract shared by the wallet and the Worker — see
  -- src/shared/theme-sync-wire.ts, which cloudflare-worker/db.js ports by hand.
  -- Entries written by older clients live here forever, so the shape must be
  -- extended rather than changed.
  entries    jsonb not null default '{}'::jsonb,

  updated_at timestamptz not null default now()
);

-- ⚠ REQUIRES A REAL service_role KEY IN SUPABASE_SERVICE_KEY.
--
-- RLS is enabled with NO policies, so only a key that bypasses RLS can read or
-- write. Do not "fix" this by adding a permissive policy: anyone able to write
-- here could push themes into someone else's wallet — at best vandalism, at
-- worst a deliberately unreadable colour scheme over a signing prompt. Writes are
-- authorized above this table instead, by an EIP-191 ownership signature the
-- Worker verifies (cloudflare-worker/db.js, action `themes-update`).
alter table public.cl_themes enable row level security;
