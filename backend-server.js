require('dotenv').config({ path: __dirname + '/.env' });
const _envCheck = { moralis: !!process.env.MORALIS_KEY, alchemy: !!process.env.ALCHEMY_KEY, cwd: process.cwd(), dir: __dirname };
console.log('🔑 ENV check:', JSON.stringify(_envCheck));
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// ─── Supabase (optional — only active if env vars are set) ────────────────────
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  console.log('✅ Supabase connected');
} else {
  console.warn('⚠️  SUPABASE_URL / SUPABASE_SERVICE_KEY missing — profile features disabled');
}

// ─── Ethers for EVM signature verification ────────────────────────────────────
let ethersVerify = null;
try {
  const { ethers } = require('ethers');
  // Works for both ethers v5 (utils.verifyMessage) and v6 (verifyMessage)
  ethersVerify = ethers.verifyMessage
    ? (msg, sig) => ethers.verifyMessage(msg, sig)
    : (msg, sig) => ethers.utils.verifyMessage(msg, sig);
  console.log('✅ ethers loaded for EVM signature verification');
} catch (e) { console.warn('⚠️  ethers not installed — EVM sig verification skipped'); }

// ─── TweetNaCl for Solana signature verification ──────────────────────────────
let nacl = null;
try { nacl = require('tweetnacl'); console.log('✅ tweetnacl loaded'); }
catch (e) { console.warn('⚠️  tweetnacl not installed — Solana sig verification skipped'); }

// ─── Inline base58 decoder (Solana pubkey decode, no heavy dep) ───────────────
const BASE58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58Decode = (input) => {
  let bytes = [0];
  for (const char of input) {
    const val = BASE58_ALPHA.indexOf(char);
    if (val < 0) throw new Error('Invalid base58 char: ' + char);
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const char of input) { if (char !== '1') break; bytes.push(0); }
  return Buffer.from(bytes.reverse());
};

const JWT_SECRET = process.env.JWT_SECRET || 'chainlens-dev-secret-CHANGE-IN-PRODUCTION';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:10000';

// ─── In-memory nonce store (auto-cleaned every 5 min) ────────────────────────
const _authNonces = {}; // { address_lower: { nonce, expires } }
const _oauthStates = {}; // { state: { expires } }
setInterval(() => {
  const now = Date.now();
  Object.keys(_authNonces).forEach(k => { if (_authNonces[k].expires < now) delete _authNonces[k]; });
  Object.keys(_oauthStates).forEach(k => { if (_oauthStates[k].expires < now) delete _oauthStates[k]; });
}, 5 * 60 * 1000);

// ─── Auth middleware ──────────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) { res.status(401).json({ error: 'Invalid or expired token' }); }
};

// ─── DB helpers ──────────────────────────────────────────────────────────────
const dbUpsertUser = async ({ provider, provider_id, display_name, avatar_url, email }) => {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('cl_users')
    .upsert({ provider, provider_id, display_name, avatar_url, email },
             { onConflict: 'provider,provider_id' })
    .select().single();
  if (error) throw error;
  return data;
};

const dbGetUserById = async (id) => {
  if (!supabase) return null;
  const { data } = await supabase
    .from('cl_users')
    .select('*, cl_wallets(*), cl_linked_accounts(*)')
    .eq('id', id).single();
  return data;
};

const dbLinkSocialAccount = async (userId, { provider, provider_id, display_name, avatar_url, email }) => {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('cl_linked_accounts')
    .upsert({ user_id: userId, provider, provider_id, display_name, avatar_url, email },
             { onConflict: 'provider,provider_id' })
    .select().single();
  if (error) throw error;
  return data;
};

// Find a user who already has this social account linked
const dbFindUserBySocial = async (provider, provider_id) => {
  if (!supabase) return null;
  const { data } = await supabase
    .from('cl_linked_accounts')
    .select('user_id')
    .eq('provider', provider)
    .eq('provider_id', provider_id)
    .single();
  if (!data) return null;
  return dbGetUserById(data.user_id);
};

const dbLinkWallet = async (userId, { chain, address }) => {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('cl_wallets')
    .upsert({ user_id: userId, chain, address, verified_at: new Date().toISOString() },
             { onConflict: 'user_id,address' })
    .select().single();
  if (error) throw error;
  return data;
};

const app = express();
const PORT = process.env.PORT || 10000; 

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const API_KEYS = {
  alchemy: process.env.ALCHEMY_KEY,
  blockfrost: process.env.BLOCKFROST_KEY,
  helius: process.env.HELIUS_KEY, 
  unstoppable: process.env.UNSTOPPABLE_KEY,
  dexhunter: process.env.DEXHUNTER_PARTNER_ID,
  jupiter: process.env.JUPITER_API_KEY, 
  uniswap: process.env.UNISWAP_API_KEY,
  zerion: process.env.ZERION_KEY,
  moralis: process.env.MORALIS_KEY
};

// --- Price Discovery Helper ---

// CoinGecko IDs for native tokens
const NATIVE_CG_IDS = {
  ETH: 'ethereum', MATIC: 'matic-network', POL: 'matic-network',
  AVAX: 'avalanche-2', RON: 'ronin', APE: 'apecoin',
  MON: 'monad', SOL: 'solana', ADA: 'cardano', BNB: 'binancecoin',
  xDAI: 'xdai', HYPE: 'hyperliquid'
};

// Simple price cache — 90s TTL
const _priceCache = {};
const _cGet = (k) => (_priceCache[k] && Date.now() - _priceCache[k].ts < 90000) ? _priceCache[k].v : null;
const _cSet = (k, v) => { _priceCache[k] = { v, ts: Date.now() }; return v; };

// Single CoinGecko fetch with cache
const fetchCoinGeckoPrice = async (cgId) => {
  const hit = _cGet(cgId);
  if (hit !== null) return hit;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd`);
    const d = await r.json();
    return _cSet(cgId, d[cgId]?.usd || 0);
  } catch (e) { return _cSet(cgId, 0); }
};

// Fetch price for a native token by symbol
const fetchNativePrice = async (symbol) => {
  const cgId = NATIVE_CG_IDS[symbol?.toUpperCase()];
  return cgId ? fetchCoinGeckoPrice(cgId) : 0;
};

// DexScreener chain IDs
const DS_CHAIN = {
  ethereum:'ethereum', base:'base', polygon:'polygon', abstract:'abstract',
  monad:'monad', avalanche:'avalanche', optimism:'optimism', arbitrum:'arbitrum',
  blast:'blast', zora:'zora', apechain:'ape', soneium:'soneium',
  ronin:'ronin', worldchain:'worldchain',
};

// ERC20 price via DexScreener, with cache
const fetchUSDPrice = async (chainId, address) => {
  if (!address || address === '0x0000000000000000000000000000000000000000') return 0;
  const key = `ds-${chainId}-${address}`;
  const hit = _cGet(key);
  if (hit !== null) return hit;
  try {
    const dsChain = DS_CHAIN[chainId] || chainId;
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await res.json();
    const pair = data.pairs?.find(p => p.chainId === dsChain) || data.pairs?.[0];
    return _cSet(key, pair ? parseFloat(pair.priceUsd) : 0);
  } catch (e) { return _cSet(key, 0); }
};

// Convert a USD value to native token equivalent, formatted to 4dp
const toNativePrice = (usdValue, nativeUsdPrice) =>
  (nativeUsdPrice > 0 && usdValue > 0) ? (usdValue / nativeUsdPrice).toFixed(4) : '0.0000';

// Image cache — 24hr TTL (logos rarely change)
const _imageCache = {};
const fetchTokenImage = async (symbol) => {
  if (!symbol) return '';
  const key = symbol.toLowerCase();
  if (_imageCache[key] !== undefined) return _imageCache[key];
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`);
    if (!r.ok) { _imageCache[key] = ''; return ''; }
    const d = await r.json();
    const hit = d.coins?.find(c => c.symbol?.toLowerCase() === key) || d.coins?.[0];
    const img = hit?.large || hit?.small || hit?.thumb || '';
    _imageCache[key] = img;
    return img;
  } catch { _imageCache[key] = ''; return ''; }
};

// ══════════════════════════════════════════════════════════════════════════════
// AUTH & PROFILE ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── Step 1: Generate a nonce for wallet signing (public, no auth) ─────────────
app.post('/api/auth/nonce', (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: 'address required' });
  const key = address.toLowerCase();
  const nonce = crypto.randomBytes(32).toString('hex');
  _authNonces[key] = { nonce, expires: Date.now() + 5 * 60 * 1000 };
  res.json({ nonce });
});

// ── Step 2a: Login / link via wallet signature ────────────────────────────────
// If Authorization header present → links wallet to existing account
// If no header → creates/finds account keyed by wallet address
app.post('/api/auth/wallet-login', async (req, res) => {
  const { chain, address, signature, key: cborKey, nonce } = req.body;
  if (!chain || !address || !signature || !nonce)
    return res.status(400).json({ error: 'chain, address, signature, nonce required' });

  // Validate nonce
  const addrKey = address.toLowerCase();
  const stored = _authNonces[addrKey];
  if (!stored || stored.nonce !== nonce || stored.expires < Date.now())
    return res.status(400).json({ error: 'Invalid or expired nonce' });
  delete _authNonces[addrKey]; // consume

  const message = `ChainLens login\nAddress: ${address}\nNonce: ${nonce}`;

  // ── Verify signature ──────────────────────────────────────────────────────
  if (chain === 'evm' && ethersVerify) {
    try {
      const recovered = ethersVerify(message, signature);
      if (recovered.toLowerCase() !== address.toLowerCase())
        return res.status(400).json({ error: 'EVM signature mismatch' });
    } catch (e) { return res.status(400).json({ error: 'Invalid EVM signature' }); }
  }

  if (chain === 'solana' && nacl) {
    try {
      const msgBytes = Buffer.from(message);
      const sigBytes = Buffer.from(signature, 'base64');
      const pubBytes = base58Decode(address);
      const valid = nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes);
      if (!valid) return res.status(400).json({ error: 'Solana signature mismatch' });
    } catch (e) { return res.status(400).json({ error: 'Invalid Solana signature' }); }
  }

  // Cardano CIP-30 — signature is CBOR; basic address ownership check for now
  // Full CIP-8 verification: add @emurgo/cardano-serialization-lib-nodejs
  if (chain === 'cardano') {
    if (!signature || !cborKey)
      return res.status(400).json({ error: 'Cardano requires signature + key' });
    // TODO: decode CBOR and verify with CSL for production hardening
    console.log(`ℹ️ Cardano wallet ${address.substring(0, 20)}... linked (signature accepted)`);
  }

  // ── Determine if this is a link (existing session) or new login ───────────
  const authHeader = req.headers.authorization?.replace('Bearer ', '');
  let userId = null;

  if (authHeader) {
    try {
      const claims = jwt.verify(authHeader, JWT_SECRET);
      userId = claims.sub;
    } catch (e) { /* token invalid — treat as new login */ }
  }

  if (supabase) {
    if (userId) {
      // Link wallet to existing account
      await dbLinkWallet(userId, { chain, address });
      const profile = await dbGetUserById(userId);
      return res.json({ success: true, profile });
    } else {
      // Create/find account by wallet address
      const user = await dbUpsertUser({
        provider: chain + '_wallet',
        provider_id: address.toLowerCase(),
        display_name: address.substring(0, 8) + '...' + address.slice(-4),
        avatar_url: null, email: null
      });
      await dbLinkWallet(user.id, { chain, address });
      const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '30d' });
      const profile = await dbGetUserById(user.id);
      return res.json({ token, profile });
    }
  } else {
    // Supabase not configured — return a mock token so frontend still works
    const mockUserId = crypto.createHash('sha256').update(address.toLowerCase()).digest('hex').substring(0, 24);
    const token = jwt.sign({ sub: mockUserId, address, chain }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({
      token,
      profile: {
        id: mockUserId,
        display_name: address.substring(0, 8) + '...' + address.slice(-4),
        avatar_url: null,
        provider: chain + '_wallet',
        cl_wallets: [{ id: '1', chain, address, is_primary: true, label: null }]
      }
    });
  }
});

// ── Google OAuth ──────────────────────────────────────────────────────────────
app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.redirect(`${FRONTEND_URL}/?auth_error=google_not_configured`);
  const state = crypto.randomBytes(16).toString('hex');
  _oauthStates[state] = {
    expires: Date.now() + 10 * 60 * 1000,
    linkToken: req.query.link_token || null  // present = link mode, absent = login mode
  };
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_CALLBACK_URL || `${FRONTEND_URL}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect(`${FRONTEND_URL}/?auth_error=${error || 'cancelled'}`);
  if (!_oauthStates[state]) return res.redirect(`${FRONTEND_URL}/?auth_error=invalid_state`);
  delete _oauthStates[state];
  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_CALLBACK_URL || `${FRONTEND_URL}/auth/google/callback`,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token from Google');

    // Get user info
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const info = await infoRes.json();

    const stateData = _oauthStates[state] || {};
    const linkToken = stateData.linkToken;
    let user;

    if (supabase) {
      if (linkToken) {
        // LINK MODE: add Google to an existing logged-in account
        try {
          const claims = jwt.verify(linkToken, JWT_SECRET);
          user = await dbGetUserById(claims.sub);
          if (!user) throw new Error('User not found');
          await dbLinkSocialAccount(user.id, {
            provider: 'google', provider_id: info.id,
            display_name: info.name, avatar_url: info.picture, email: info.email
          });
          await supabase.from('cl_users').update({
            avatar_url: user.avatar_url || info.picture,
            email: user.email || info.email
          }).eq('id', user.id);
          const jwtToken = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '30d' });
          return res.redirect(`${FRONTEND_URL}/?auth_token=${jwtToken}&linked=google`);
        } catch (e) {
          console.error('Google link error:', e);
          return res.redirect(`${FRONTEND_URL}/?auth_error=link_failed`);
        }
      } else {
        // LOGIN MODE: find existing linked account or create new user
        const existing = await dbFindUserBySocial('google', info.id);
        if (existing) {
          user = existing;
          await dbLinkSocialAccount(user.id, {
            provider: 'google', provider_id: info.id,
            display_name: info.name, avatar_url: info.picture, email: info.email
          });
        } else {
          user = await dbUpsertUser({ provider: 'google', provider_id: info.id, display_name: info.name, avatar_url: info.picture, email: info.email });
          await dbLinkSocialAccount(user.id, {
            provider: 'google', provider_id: info.id,
            display_name: info.name, avatar_url: info.picture, email: info.email
          });
        }
      }
    } else {
      user = { id: crypto.createHash('sha256').update('google:' + info.id).digest('hex').substring(0, 24), display_name: info.name, avatar_url: info.picture };
    }

    const jwtToken = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.redirect(`${FRONTEND_URL}/?auth_token=${jwtToken}`);
  } catch (e) {
    console.error('Google OAuth error:', e);
    res.redirect(`${FRONTEND_URL}/?auth_error=google_failed`);
  }
});

// ── Discord OAuth ─────────────────────────────────────────────────────────────
app.get('/auth/discord', (req, res) => {
  if (!process.env.DISCORD_CLIENT_ID) return res.redirect(`${FRONTEND_URL}/?auth_error=discord_not_configured`);
  const state = crypto.randomBytes(16).toString('hex');
  _oauthStates[state] = {
    expires: Date.now() + 10 * 60 * 1000,
    linkToken: req.query.link_token || null  // present = link mode, absent = login mode
  };
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_CALLBACK_URL || `${FRONTEND_URL}/auth/discord/callback`,
    response_type: 'code',
    scope: 'identify email',
    state
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect(`${FRONTEND_URL}/?auth_error=${error || 'cancelled'}`);
  if (!_oauthStates[state]) return res.redirect(`${FRONTEND_URL}/?auth_error=invalid_state`);
  delete _oauthStates[state];
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        redirect_uri: process.env.DISCORD_CALLBACK_URL || `${FRONTEND_URL}/auth/discord/callback`,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token from Discord');

    const infoRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const info = await infoRes.json();
    const avatar = info.avatar
      ? `https://cdn.discordapp.com/avatars/${info.id}/${info.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/${parseInt(info.discriminator || 0) % 5}.png`;

    const stateData = _oauthStates[state] || {};
    const linkToken = stateData.linkToken;
    const discordName = info.global_name || info.username;
    let user;

    if (supabase) {
      if (linkToken) {
        // LINK MODE: add Discord to an existing logged-in account
        try {
          const claims = jwt.verify(linkToken, JWT_SECRET);
          user = await dbGetUserById(claims.sub);
          if (!user) throw new Error('User not found');
          await dbLinkSocialAccount(user.id, {
            provider: 'discord', provider_id: info.id,
            display_name: discordName, avatar_url: avatar, email: info.email
          });
          await supabase.from('cl_users').update({
            avatar_url: user.avatar_url || avatar
          }).eq('id', user.id);
          const jwtToken = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '30d' });
          return res.redirect(`${FRONTEND_URL}/?auth_token=${jwtToken}&linked=discord`);
        } catch (e) {
          console.error('Discord link error:', e);
          return res.redirect(`${FRONTEND_URL}/?auth_error=link_failed`);
        }
      } else {
        // LOGIN MODE: find existing linked account or create new user
        const existing = await dbFindUserBySocial('discord', info.id);
        if (existing) {
          user = existing;
          await dbLinkSocialAccount(user.id, {
            provider: 'discord', provider_id: info.id,
            display_name: discordName, avatar_url: avatar, email: info.email
          });
        } else {
          user = await dbUpsertUser({ provider: 'discord', provider_id: info.id, display_name: discordName, avatar_url: avatar, email: info.email });
          await dbLinkSocialAccount(user.id, {
            provider: 'discord', provider_id: info.id,
            display_name: discordName, avatar_url: avatar, email: info.email
          });
        }
      }
    } else {
      user = { id: crypto.createHash('sha256').update('discord:' + info.id).digest('hex').substring(0, 24), display_name: discordName, avatar_url: avatar };
    }

    const jwtToken = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.redirect(`${FRONTEND_URL}/?auth_token=${jwtToken}`);
  } catch (e) {
    console.error('Discord OAuth error:', e);
    res.redirect(`${FRONTEND_URL}/?auth_error=discord_failed`);
  }
});

// ── Profile routes (require auth) ─────────────────────────────────────────────
app.get('/api/profile', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  const profile = await dbGetUserById(req.user.sub);
  if (!profile) return res.status(404).json({ error: 'User not found' });
  res.json(profile);
});

app.patch('/api/profile', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  const { display_name } = req.body;
  const { data } = await supabase
    .from('cl_users').update({ display_name }).eq('id', req.user.sub).select().single();
  res.json(data);
});

app.post('/api/profile/wallet', requireAuth, async (req, res) => {
  // Link additional wallet to an already-authenticated account
  // Re-uses the wallet-login endpoint logic but always links (never creates new user)
  req.headers.authorization = req.headers.authorization; // already set
  // Delegate to wallet-login with the auth header present
  // (wallet-login checks for Authorization and links if present)
  return res.redirect(307, '/api/auth/wallet-login');
});

app.patch('/api/profile/wallet/:walletId', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  const { label, is_primary } = req.body;
  const updates = {};
  if (label !== undefined) updates.label = label;
  if (is_primary !== undefined) updates.is_primary = is_primary;
  const { data } = await supabase
    .from('cl_wallets').update(updates)
    .eq('id', req.params.walletId).eq('user_id', req.user.sub)
    .select().single();
  res.json(data);
});

app.delete('/api/profile/wallet/:walletId', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  await supabase.from('cl_wallets')
    .delete().eq('id', req.params.walletId).eq('user_id', req.user.sub);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// END AUTH & PROFILE ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// --- DOMAIN RESOLUTION ---

// 1. Unstoppable Domains
app.get('/api/resolve/unstoppable/:domain', async (req, res) => {
  const { domain } = req.params;
  try {
    const response = await fetch(`https://api.unstoppabledomains.com/resolve/domains/${domain}`, {
      headers: { 'Authorization': `Bearer ${API_KEYS.unstoppable}`, 'Accept': 'application/json' }
    });
    if (!response.ok) return res.status(404).json({ error: 'Domain not found.' });
    const data = await response.json();
    const address = data.records?.['crypto.ETH.address'] || data.meta?.owner;
    if (address) res.json({ address });
    else res.status(404).json({ error: 'No EVM address linked.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. ENS Resolution (Ethereum)
app.get('/api/resolve/ens/:name', async (req, res) => {
  const { name } = req.params;
  try {
    const url = `https://eth-mainnet.g.alchemy.com/v2/${API_KEYS.alchemy}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_resolveName",
        params: [name],
        id: 1
      })
    });
    const data = await response.json();
    if (data.result) res.json({ address: data.result });
    else res.status(404).json({ error: 'ENS name not resolved.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. ADA Handle Resolution (Cardano) - REPAIRED
app.get('/api/resolve/handle/:handle', async (req, res) => {
  // Normalize: Strip $ and convert to lowercase as per Cardano standards
  let handle = req.params.handle.replace('$', '').toLowerCase();
  
  try {
    // Attempt 1: Official Handle.me API lookup
    const handleRes = await fetch(`https://api.handle.me/lookup/${handle}`);
    if (handleRes.ok) {
      const handleData = await handleRes.json();
      if (handleData.address) {
        return res.json({ address: handleData.address });
      }
    }

    // Attempt 2: Manual Fallback via Blockfrost (Using ADA Handle Policy ID)
    // Policy ID for Mainnet ADA Handles: f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a
    const policyId = "f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a";
    const assetNameHex = Buffer.from(handle).toString('hex');
    const assetId = policyId + assetNameHex;

    const bfRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/assets/${assetId}/addresses`, {
      headers: { 'project_id': API_KEYS.blockfrost }
    });
    
    if (bfRes.ok) {
      const bfData = await bfRes.json();
      // Blockfrost returns an array: [{ address: "addr1...", quantity: "1" }]
      if (bfData && bfData.length > 0 && bfData[0].address) {
        return res.json({ address: bfData[0].address });
      }
    }

    res.status(404).json({ error: 'Handle not found or not minted.' });
  } catch (err) { 
    console.error("Resolution Error:", err);
    res.status(500).json({ error: "Server error during handle resolution." }); 
  }
});

// --- SWAP INTEGRATIONS ---

// 1. Cardano (DexHunter)
app.get('/api/swap/cardano/quote', async (req, res) => {
  const { fromToken, toToken, amount } = req.query;
  try {
    const response = await fetch(`https://api.dexhunter.io/v1/swap/quote?from=${fromToken}&to=${toToken}&amount=${amount}`, {
      headers: { 
        'X-Partner-Id': API_KEYS.dexhunter,
        'Accept': 'application/json' 
      }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch Cardano swap quote" });
  }
});

// 2. Solana (Jupiter)
app.get('/api/swap/solana/quote', async (req, res) => {
  const { inputMint, outputMint, amount, slippageBps = 50 } = req.query;
  try {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch Solana swap quote" });
  }
});

// 3. EVM (Uniswap Routing API)
app.post('/api/swap/evm/quote', async (req, res) => {
  try {
    const response = await fetch(`https://api.uniswap.org/v2/quote`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-api-key': API_KEYS.uniswap 
      },
      body: JSON.stringify(req.body) 
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch EVM swap quote" });
  }
});

// --- ASSET HELPERS ---

const fetchAlchemyNFTs = async (network, address, chainId) => {
  try {
    const url = `https://${network}.g.alchemy.com/nft/v3/${API_KEYS.alchemy}/getNFTsForOwner?owner=${address}&withMetadata=true`;
    console.log(`🔍 Fetching NFTs for ${chainId} from:`, url);
    
    const res = await fetch(url);
    const data = await res.json();
    
    if (!res.ok) {
      console.error(`❌ Alchemy NFT API error for ${chainId}:`, res.status, data);
      return [];
    }
    
    console.log(`✅ ${chainId}: Found ${data.ownedNfts?.length || 0} NFTs`);
    
    return (data.ownedNfts || []).map(nft => ({
      id: `${chainId}-${nft.contract.address}-${nft.tokenId}`,
      name: nft.name || nft.title || 'Unnamed NFT',
      image: nft.image?.cachedUrl || nft.image?.thumbnailUrl || nft.image?.originalUrl || '',
      collection: nft.contract.name || 'Collection',
      chain: chainId,
      isToken: false,
      metadata: { 
        traits: nft.raw?.metadata?.attributes || nft.raw?.metadata?.traits || [], 
        description: nft.description || '' 
      }
    }));
  } catch (e) { 
    console.error(`❌ Error fetching NFTs for ${chainId}:`, e.message);
    return []; 
  }
};

const fetchAlchemyTokens = async (network, address, chainId) => {
  try {
    const baseUrl = `https://${network}.g.alchemy.com/v2/${API_KEYS.alchemy}`;
    console.log(`💰 Fetching tokens for ${chainId} from:`, baseUrl);
    
    const nativeTask = fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [address, "latest"], id: 1 })
    }).then(r => r.json());

    const erc20Task = fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: "2.0", method: "alchemy_getTokenBalances", params: [address], id: 2 })
    }).then(r => r.json());

    const [nativeRes, erc20Res] = await Promise.all([nativeTask, erc20Task]);
    const tokens = [];

    // Native token config — all ETH-equivalent L2s share the same symbol/logo
    const _nc = {
      polygon:    { symbol:'POL',  name:'Polygon',   logo:'https://cryptologos.cc/logos/polygon-matic-logo.png' },
      avalanche:  { symbol:'AVAX', name:'Avalanche',  logo:'https://cryptologos.cc/logos/avalanche-avax-logo.png' },
      ronin:      { symbol:'RON',  name:'Ronin',      logo:'https://cryptologos.cc/logos/ronin-ron-logo.png' },
      apechain:   { symbol:'APE',  name:'ApeCoin',    logo:'https://cryptologos.cc/logos/apecoin-ape-ape-logo.png' },
      gnosis:     { symbol:'xDAI', name:'Gnosis',     logo:'https://cryptologos.cc/logos/gnosis-gno-logo.png' },
      hyperevm:   { symbol:'HYPE', name:'HyperEVM',   logo:'https://via.placeholder.com/100/6366f1/ffffff?text=HYPE' },
    };
    const { symbol: nativeSymbol, name: nativeName, logo: nativeLogo } =
      _nc[chainId] || { symbol:'ETH', name:'Ether', logo:'https://cryptologos.cc/logos/ethereum-eth-logo.png' };

    // Use CoinGecko by symbol — avoids chain-specific WETH address failures on L2s
    const nativeUsdPrice = await fetchNativePrice(nativeSymbol);

    if (nativeRes.result) {
      const balance = parseInt(nativeRes.result, 16) / 1e18;
      if (balance > 0) {
        tokens.push({
          id: 'native',
          name: nativeName,
          symbol: nativeSymbol,
          balance: balance.toFixed(4),
          usdPrice: nativeUsdPrice,
          nativePrice: balance.toFixed(4),
          totalValue: (balance * nativeUsdPrice).toFixed(2),
          image: nativeLogo,
          chain: chainId,
          isToken: true
        });
      }
    }

    const balances = erc20Res.result?.tokenBalances || [];
    const nonZero = balances.filter(t => parseInt(t.tokenBalance, 16) > 0).slice(0, 15);

    const erc20Results = await Promise.all(nonZero.map(async (token) => {
      try {
        const metaRes = await fetch(baseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: "2.0", method: "alchemy_getTokenMetadata", params: [token.contractAddress], id: 3 })
        });
        const meta = await metaRes.json();
        const metadata = meta.result;
        const balance = parseInt(token.tokenBalance, 16) / Math.pow(10, metadata.decimals || 18);
        if (balance < 0.000001) return null;

        const usdPrice = await fetchUSDPrice(chainId, token.contractAddress);
        
        // Calculate native price: if token is $10 and native is $3000, token = 0.0033 native
        const nativePrice = nativeUsdPrice > 0 ? (usdPrice / nativeUsdPrice) : 0;

        return {
          id: token.contractAddress,
          name: metadata.name || 'Unknown',
          symbol: metadata.symbol || '???',
          balance: balance.toFixed(4),
          usdPrice: usdPrice,
          nativePrice: nativePrice.toFixed(4), // Price per token in native currency
          totalValue: (balance * usdPrice).toFixed(2),
          image: metadata.logo
            || `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/${token.contractAddress}/logo.png`
            || await fetchTokenImage(metadata.symbol),
          chain: chainId,
          isToken: true
        };
      } catch (e) { return null; }
    }));

    const filteredTokens = [...tokens, ...erc20Results.filter(t => t !== null)];
    console.log(`✅ ${chainId}: Found ${filteredTokens.length} tokens`);
    return filteredTokens;
  } catch (e) { 
    console.error(`❌ Error fetching tokens for ${chainId}:`, e.message);
    return []; 
  }
};

// --- Routes ---
// Alchemy-supported chains confirmed from their API documentation
const evmChains = [
  { id: 'ethereum', net: 'eth-mainnet' },
  { id: 'base', net: 'base-mainnet' },
  { id: 'polygon', net: 'polygon-mainnet' },
  { id: 'avalanche', net: 'avax-mainnet' },
  { id: 'optimism', net: 'opt-mainnet' },
  { id: 'arbitrum', net: 'arb-mainnet' },
  { id: 'blast', net: 'blast-mainnet' },
  { id: 'zora', net: 'zora-mainnet' },
  { id: 'abstract', net: 'abstract-mainnet' },
  { id: 'apechain', net: 'apechain-mainnet' },
  { id: 'soneium', net: 'soneium-mainnet' },
  { id: 'ronin', net: 'ronin-mainnet' },
  { id: 'worldchain', net: 'worldchain-mainnet' },
  { id: 'gnosis', net: 'gnosis-mainnet' },
  { id: 'hyperevm', net: 'hyperevm-mainnet' } // Hyperliquid EVM
];

evmChains.forEach(chain => {
  app.get(`/api/nfts/${chain.id}/:address`, (req, res) => {
    fetchAlchemyNFTs(chain.net, req.params.address, chain.id)
      .then(n => res.json({ nfts: n }))
      .catch(err => {
        console.error(`❌ Route error for ${chain.id} NFTs:`, err.message);
        res.json({ nfts: [] });
      });
  });
  
  app.get(`/api/tokens/${chain.id}/:address`, (req, res) => {
    fetchAlchemyTokens(chain.net, req.params.address, chain.id)
      .then(t => res.json({ nfts: t }))
      .catch(err => {
        console.error(`❌ Route error for ${chain.id} tokens:`, err.message);
        res.json({ nfts: [] });
      });
  });
});

// --- Monad (via Moralis API) ---
app.get('/api/:mode(nfts|tokens)/monad/:address', async (req, res) => {
  const { mode, address } = req.params;
  try {
    console.log(`📡 Fetching Monad ${mode} for ${address} via Moralis...`);

    if (!API_KEYS.moralis) {
      console.error('❌ MORALIS_KEY is missing from .env!');
      return res.json({ nfts: [] });
    }

    const moralisHeaders = {
      'accept': 'application/json',
      'X-API-Key': API_KEYS.moralis
    };

    if (mode === 'tokens') {
      const [nativeRes, erc20Res] = await Promise.all([
        fetch(`https://deep-index.moralis.io/api/v2.2/${address}/balance?chain=0x8f`, { headers: moralisHeaders }),
        fetch(`https://deep-index.moralis.io/api/v2.2/${address}/erc20?chain=0x8f`, { headers: moralisHeaders })
      ]);

      // Log full error body for both — previously this was swallowed silently
      if (!nativeRes.ok) {
        const errBody = await nativeRes.text();
        console.error(`❌ Moralis native balance error ${nativeRes.status}:`, errBody);
      }
      if (!erc20Res.ok) {
        const errBody = await erc20Res.text();
        console.error(`❌ Moralis ERC20 error ${erc20Res.status}:`, errBody);
      }

      // Previous code used AND (&&) — if only one failed we'd silently get NaN balances.
      // Now bail if either fails.
      if (!nativeRes.ok || !erc20Res.ok) {
        return res.json({ nfts: [] });
      }

      const tokens = [];
      const [nativeData, erc20Data] = await Promise.all([nativeRes.json(), erc20Res.json()]);

      console.log('  Moralis native response:', JSON.stringify(nativeData));
      console.log('  Moralis ERC20 result count:', erc20Data.result?.length ?? 'no result field');

      // Fetch MON price once — used by native token AND all ERC20 nativePrice calculations
      const monUsdPrice = await fetchNativePrice('MON');

      // Native MON balance
      const rawBalance = nativeData.balance;
      if (rawBalance && rawBalance !== '0') {
        const balance = parseInt(rawBalance, 10) / 1e18;
        if (balance > 0) {
          tokens.push({
            id: 'native-mon',
            name: 'Monad',
            symbol: 'MON',
            balance: balance.toFixed(4),
            usdPrice: monUsdPrice,
            nativePrice: '1.0000', // MON in MON = 1
            totalValue: (balance * monUsdPrice).toFixed(2),
            image: 'https://assets.coingecko.com/coins/images/54540/small/monad.png',
            chain: 'monad',
            isToken: true
          });
        }
      }

      // ERC20 tokens — Moralis first, then RPC fallback for unindexed tokens
      const MONAD_RPC = 'https://monad-mainnet.drpc.org';
      const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

      const moralisResult = erc20Data.result || [];
      console.log(`  Moralis returned ${moralisResult.length} ERC20 tokens`);

      // Process whatever Moralis did return
      const moralisTokens = await Promise.all(moralisResult.map(async (t) => {
        const decimals = parseInt(t.decimals) ?? 18;
        const balance = t.balance_formatted
          ? parseFloat(t.balance_formatted)
          : parseInt(t.balance || '0', 10) / Math.pow(10, decimals);
        if (!balance || balance < 0.000001) return null;
        const usdPrice = await fetchUSDPrice('monad', t.token_address);
        const nativePrice = monUsdPrice > 0 ? (usdPrice / monUsdPrice) : 0; // Fixed: price per token in MON
        
        return {
          id: t.token_address,
          name: t.name || 'Unknown Token',
          symbol: t.symbol || '???',
          balance: balance.toFixed(4),
          usdPrice,
          nativePrice: nativePrice.toFixed(4), // Price per token in MON
          totalValue: (balance * usdPrice).toFixed(2),
          image: t.logo || t.thumbnail || `https://via.placeholder.com/400/836EF9/ffffff?text=${t.symbol || 'MON'}`,
          chain: 'monad',
          isToken: true,
          address: t.token_address
        };
      }));
      tokens.push(...moralisTokens.filter(t => t !== null));

      // Direct RPC fallback using official Monad RPC endpoints
      // Calls balanceOf for a curated list of known Monad tokens + scans recent Transfer logs
      console.log('  Running direct RPC fallback for unindexed Monad ERC20 tokens...');
      const knownAddresses = new Set(moralisResult.map(t => t.token_address?.toLowerCase()));

      // Known popular Monad mainnet token contracts
      const KNOWN_MONAD_TOKENS = [
        '0x81a224f8a62f52bde942dbf23a56df77a10b7777', // emonad (EMO)
        '0x3bd359c1119da7da1d913d1c4d2b7c461115433a', // Wrapped MON (WMON)
        '0xee8c0e9f1bffb4eb878d8f15f368a02a35481242', // Wrapped ETH (WETH)
        '0xe7cd86e13ac4309349f30b3435a9d337750fc82d', // USDT0
        '0x01bff41798a0bcf287b996046ca68b395dbc1071', // XAUt0
        '0x754704bc059f8c67012fed69bc8a327a5aafb603', // USDC
        '0x1ad7052bb331a0529c1981c3ec2bc4663498a110', // aprMON
        '0xcf5a6076cfa32686c0df13abada2b40dec133f1d', // shMON
        '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', // sMON (Kintsu)
      ];

      const MONAD_RPCS = [
        'https://rpc.monad.xyz',
        'https://rpc1.monad.xyz',
        'https://rpc2.monad.xyz',
      ];

      const decodeString = (hex) => {
        if (!hex || hex === '0x') return '';
        try {
          const clean = hex.slice(2);
          // Try as UTF-8 string with ABI encoding (offset + length + data)
          if (clean.length >= 128) {
            const len = parseInt(clean.slice(64, 128), 16);
            if (len > 0 && len < 100) {
              const str = clean.slice(128, 128 + len * 2);
              return Buffer.from(str, 'hex').toString('utf8').replace(/ /g, '').trim();
            }
          }
          // Fallback: try as bytes32 fixed string
          return Buffer.from(clean.replace(/^0+/, '').padStart(64, '0').slice(0, 64), 'hex')
            .toString('utf8').replace(/ /g, '').trim();
        } catch { return ''; }
      };

      const rpcCall = async (method, params) => {
        for (const rpc of MONAD_RPCS) {
          try {
            const res = await fetch(rpc, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
            });
            const data = await res.json();
            if (data.result !== undefined) return data.result;
          } catch (e) { /* try next RPC */ }
        }
        return null;
      };

      try {
        // Step 1: Check balances for known token list
        const contractsToCheck = KNOWN_MONAD_TOKENS.filter(a => !knownAddresses.has(a.toLowerCase()));
        console.log(`  Checking ${contractsToCheck.length} known token contracts via RPC...`);

        const rpcTokens = await Promise.all(contractsToCheck.map(async (contractAddr) => {
          try {
            const balanceData = '0x70a08231' + '000000000000000000000000' + address.slice(2).toLowerCase();
            const [balResult, decResult, symResult, nameResult] = await Promise.all([
              rpcCall('eth_call', [{ to: contractAddr, data: balanceData }, 'latest']),
              rpcCall('eth_call', [{ to: contractAddr, data: '0x313ce567' }, 'latest']),
              rpcCall('eth_call', [{ to: contractAddr, data: '0x95d89b41' }, 'latest']),
              rpcCall('eth_call', [{ to: contractAddr, data: '0x06fdde03' }, 'latest']),
            ]);

            if (!balResult || balResult === '0x' || balResult === '0x' + '0'.repeat(64)) return null;
            const rawBal = BigInt(balResult);
            if (rawBal === 0n) return null;

            const decimals = decResult && decResult !== '0x' ? parseInt(decResult, 16) : 18;
            const symbol = decodeString(symResult) || 'UNKNOWN';
            const name = decodeString(nameResult) || symbol;
            const balance = Number(rawBal) / Math.pow(10, decimals);

            if (balance < 0.000001) return null;
            console.log(`  ✅ RPC found: ${symbol} (${name}) = ${balance}`);

            const usdPrice = await fetchUSDPrice('monad', contractAddr);
            const nativePrice = monUsdPrice > 0 ? (usdPrice / monUsdPrice) : 0; // Fixed: price per token in MON
            
            return {
              id: contractAddr,
              name,
              symbol,
              balance: balance.toFixed(4),
              usdPrice,
              nativePrice: nativePrice.toFixed(4), // Price per token in MON
              totalValue: (balance * usdPrice).toFixed(2),
              image: `https://via.placeholder.com/50/836EF9/ffffff?text=${encodeURIComponent(symbol)}`,
              chain: 'monad',
              isToken: true,
              address: contractAddr
            };
          } catch (e) {
            console.error(`  RPC balanceOf failed for ${contractAddr}:`, e.message);
            return null;
          }
        }));
        tokens.push(...rpcTokens.filter(t => t !== null));

        // Step 2: Scan recent Transfer logs to catch any tokens not in our known list
        const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
        const paddedAddress = '0x000000000000000000000000' + address.slice(2).toLowerCase();
        const latestBlock = await rpcCall('eth_blockNumber', []);
        if (latestBlock) {
          const latest = parseInt(latestBlock, 16);
          // Only scan last 500k blocks to avoid timeout
          const fromBlock = '0x' + Math.max(0, latest - 500000).toString(16);
          console.log(`  Scanning Transfer logs from block ${fromBlock} to latest...`);
          const logs = await rpcCall('eth_getLogs', [{
            topics: [ERC20_TRANSFER_TOPIC, null, paddedAddress],
            fromBlock,
            toBlock: 'latest'
          }]);

          if (logs && logs.length > 0) {
            console.log(`  Found ${logs.length} inbound Transfer logs`);
            const newContracts = [...new Set(
              logs.map(l => l.address?.toLowerCase())
                .filter(a => a && !knownAddresses.has(a) && !KNOWN_MONAD_TOKENS.map(x=>x.toLowerCase()).includes(a))
            )];
            console.log(`  ${newContracts.length} additional contracts to check`);

            const extraTokens = await Promise.all(newContracts.slice(0, 15).map(async (contractAddr) => {
              try {
                const balanceData = '0x70a08231' + '000000000000000000000000' + address.slice(2).toLowerCase();
                const [balResult, decResult, symResult, nameResult] = await Promise.all([
                  rpcCall('eth_call', [{ to: contractAddr, data: balanceData }, 'latest']),
                  rpcCall('eth_call', [{ to: contractAddr, data: '0x313ce567' }, 'latest']),
                  rpcCall('eth_call', [{ to: contractAddr, data: '0x95d89b41' }, 'latest']),
                  rpcCall('eth_call', [{ to: contractAddr, data: '0x06fdde03' }, 'latest']),
                ]);
                if (!balResult || balResult === '0x') return null;
                const rawBal = BigInt(balResult);
                if (rawBal === 0n) return null;
                const decimals = decResult && decResult !== '0x' ? parseInt(decResult, 16) : 18;
                const symbol = decodeString(symResult) || 'UNKNOWN';
                const name = decodeString(nameResult) || symbol;
                const balance = Number(rawBal) / Math.pow(10, decimals);
                if (balance < 0.000001) return null;
                console.log(`  ✅ Log scan found: ${symbol} = ${balance}`);
                const usdPrice = await fetchUSDPrice('monad', contractAddr);
                const nativePrice = monUsdPrice > 0 ? (usdPrice / monUsdPrice) : 0; // Fixed: price per token in MON
                
                return {
                  id: contractAddr, name, symbol,
                  balance: balance.toFixed(4), usdPrice,
                  totalValue: (balance * usdPrice).toFixed(2),
                  nativePrice: nativePrice.toFixed(4), // Price per token in MON
                  image: `https://via.placeholder.com/50/836EF9/ffffff?text=${encodeURIComponent(symbol)}`,
                  chain: 'monad', isToken: true, address: contractAddr
                };
              } catch { return null; }
            }));
            tokens.push(...extraTokens.filter(t => t !== null));
          }
        }
      } catch (e) {
        console.error('  Monad RPC fallback error:', e.message);
      }

      console.log(`✅ Monad: Found ${tokens.length} tokens via Moralis`);
      res.json({ nfts: tokens });

    } else {
      // Fetch NFTs
      const response = await fetch(
        `https://deep-index.moralis.io/api/v2.2/${address}/nft?chain=0x8f&format=decimal&media_items=true`,
        { headers: moralisHeaders }
      );

      if (!response.ok) {
        const errBody = await response.text();
        console.error(`❌ Moralis NFT error ${response.status}:`, errBody);
        return res.json({ nfts: [] });
      }

      const data = await response.json();
      console.log('  Moralis NFT result count:', data.result?.length ?? 'no result field');
      console.log('  Moralis NFT raw sample:', JSON.stringify(data.result?.[0] || {}));

      const nfts = (data.result || []).map(nft => {
        const meta = nft.normalized_metadata || {};
        // Try all possible image locations Moralis provides
        const rawImage = nft.media?.media_collection?.medium?.url
          || nft.media?.original_media_url
          || meta.image
          || nft.token_uri
          || '';
        const imageUrl = rawImage.startsWith('ipfs://')
          ? `https://ipfs.io/ipfs/${rawImage.replace('ipfs://', '')}`
          : rawImage;
        return {
          id: `${nft.token_address}-${nft.token_id}`,
          name: meta.name || nft.name || `Monad NFT #${nft.token_id}`,
          image: imageUrl,
          collection: nft.name || 'Monad Collection',
          chain: 'monad',
          contractAddress: nft.token_address,
          tokenId: nft.token_id,
          isToken: false,
          metadata: {
            traits: meta.attributes || [],
            description: meta.description || ''
          }
        };
      });

      console.log(`✅ Monad: Found ${nfts.length} NFTs via Moralis`);
      res.json({ nfts });
    }
  } catch (err) {
    console.error('❌ Monad Moralis error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Solana ---
app.get('/api/:mode(nfts|tokens)/solana/:address', async (req, res) => {
  const { mode, address } = req.params;
  try {
    const solPrice = await fetchUSDPrice('solana', 'So11111111111111111111111111111111111111112');
    
    // Add timestamp for cache-busting
    const timestamp = Date.now();
    const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${API_KEYS.helius}`;
    
    // Method 1: Helius Enhanced API (might be cached/delayed for new tokens)
    const heliusResponse = await fetch(heliusUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      },
      body: JSON.stringify({
        jsonrpc: '2.0', 
        id: `sol-scan-${timestamp}`, 
        method: 'getAssetsByOwner',
        params: { 
          ownerAddress: address, 
          page: 1, 
          limit: 1000, // Increased to catch all tokens
          displayOptions: {
            showFungible: mode === 'tokens',
            showNativeBalance: mode === 'tokens'
          }
        }
      })
    });
    
    const heliusData = await heliusResponse.json();
    const items = heliusData.result?.items || [];
    const nativeBalance = heliusData.result?.nativeBalance || null;
    
    console.log(`📊 Solana ${mode}: Helius returned ${items.length} items`);

    if (mode === 'tokens') {
      const tokens = [];
      
      // Add native SOL balance first
      if (nativeBalance) {
        const solBalance = (nativeBalance.lamports || 0) / 1e9;
        if (solBalance > 0) {
          tokens.push({
            id: 'native-sol',
            name: 'Solana',
            symbol: 'SOL',
            balance: solBalance.toFixed(4),
            usdPrice: solPrice,
            nativePrice: '1.0000',
            totalValue: (solBalance * solPrice).toFixed(2),
            image: 'https://assets.coingecko.com/coins/images/4128/small/solana.png',
            chain: 'solana',
            isToken: true
          });
        }
      }
      
      // Add SPL tokens from Helius
      const heliusTokens = items
        .filter(i => i.interface === 'FungibleToken' || i.interface === 'FungibleAsset')
        .map(t => {
          const balanceNum = (t.token_info?.balance / Math.pow(10, t.token_info?.decimals || 0));
          const usdPrice = t.token_info?.price_info?.price_per_token || 0;
          const nativePrice = solPrice > 0 ? (usdPrice / solPrice) : 0;
          
          return {
            id: t.id,
            mint: t.id, // Store mint address
            name: t.content?.metadata?.name || 'Solana Token',
            symbol: t.content?.metadata?.symbol || 'SPL',
            balance: balanceNum.toFixed(4),
            usdPrice: usdPrice,
            nativePrice: nativePrice.toFixed(4),
            totalValue: (balanceNum * usdPrice).toFixed(2),
            image: t.content?.links?.image
              || t.content?.links?.image_url
              || t.content?.files?.[0]?.cdn_uri
              || t.content?.files?.[0]?.uri
              || t.token_info?.image_url
              || '',
            chain: 'solana',
            isToken: true
          };
        })
        .filter(t => parseFloat(t.balance) > 0);
      
      tokens.push(...heliusTokens);
      
      // Method 2: DIRECT RPC token account lookup (catches BRAND NEW tokens Helius hasn't indexed yet)
      console.log(`🔍 Solana: Doing direct RPC token account lookup for newest tokens...`);
      try {
        const tokenAccountsResponse = await fetch(heliusUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: `token-accounts-${timestamp}`,
            method: 'getTokenAccountsByOwner',
            params: [
              address,
              { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, // SPL Token Program
              { encoding: 'jsonParsed' }
            ]
          })
        });
        
        const tokenAccountsData = await tokenAccountsResponse.json();
        const tokenAccounts = tokenAccountsData.result?.value || [];
        console.log(`📊 Solana: Direct RPC found ${tokenAccounts.length} token accounts`);
        
        // Get mints we already have from Helius
        const existingMints = new Set(tokens.map(t => t.mint || t.id));
        
        // Process token accounts
        const directTokens = await Promise.all(
          tokenAccounts
            .filter(account => {
              const mint = account.account?.data?.parsed?.info?.mint;
              const balance = account.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
              return mint && balance > 0 && !existingMints.has(mint);
            })
            .slice(0, 50) // Limit to avoid too many lookups
            .map(async (account) => {
              try {
                const mint = account.account.data.parsed.info.mint;
                const balance = account.account.data.parsed.info.tokenAmount.uiAmount;
                const decimals = account.account.data.parsed.info.tokenAmount.decimals;
                
                // Try to get metadata
                let symbol = 'UNKNOWN';
                let name = 'Unknown Token';
                let image = 'https://via.placeholder.com/100/14F195/ffffff?text=?';
                
                // Try to fetch token metadata
                try {
                  const metadataResponse = await fetch(heliusUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      jsonrpc: '2.0',
                      id: 'get-asset',
                      method: 'getAsset',
                      params: { id: mint }
                    })
                  });
                  const metadata = await metadataResponse.json();
                  if (metadata.result) {
                    symbol = metadata.result.content?.metadata?.symbol || mint.substring(0, 6);
                    name = metadata.result.content?.metadata?.name || 'New Token';
                    image = metadata.result.content?.links?.image || image;
                  }
                } catch (e) {
                  console.log(`  Unable to fetch metadata for ${mint}`);
                }
                
                // Try to get price
                const usdPrice = await fetchUSDPrice('solana', mint);
                const nativePrice = solPrice > 0 ? (usdPrice / solPrice) : 0;
                
                console.log(`  ✅ Found NEW token via RPC: ${symbol} (${mint.substring(0, 8)}...) = ${balance}`);
                
                return {
                  id: mint,
                  mint: mint,
                  name: name,
                  symbol: symbol,
                  balance: balance.toFixed(4),
                  usdPrice: usdPrice,
                  nativePrice: nativePrice.toFixed(4),
                  totalValue: (balance * usdPrice).toFixed(2),
                  image: image,
                  chain: 'solana',
                  isToken: true,
                  isNew: true // Flag to indicate this was caught via direct RPC
                };
              } catch (e) {
                console.error(`  Error processing token account:`, e.message);
                return null;
              }
            })
        );
        
        const validDirectTokens = directTokens.filter(t => t !== null);
        if (validDirectTokens.length > 0) {
          console.log(`  ✅ Added ${validDirectTokens.length} NEW tokens from direct RPC!`);
          tokens.push(...validDirectTokens);
        }
        
      } catch (rpcErr) {
        console.error(`  ⚠️ Direct RPC token lookup failed:`, rpcErr.message);
      }
      
      console.log(`✅ Solana: Returning ${tokens.length} total tokens`);
      res.json({ nfts: tokens });
      
    } else {
      const nfts = items.filter(i => i.interface !== 'FungibleToken' && i.interface !== 'FungibleAsset').map(asset => ({
        id: asset.id,
        name: asset.content?.metadata?.name || 'Solana NFT',
        chain: 'solana',
        image: asset.content?.links?.image || '',
        collection: asset.grouping?.[0]?.collection_metadata?.name || 'Solana',
        isToken: false,
        metadata: { traits: asset.content?.metadata?.attributes || [], description: asset.content?.metadata?.description || '' }
      }));
      res.json({ nfts });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Cardano ---
// 4. Solana Name Service (SNS) — .sol domains via Bonfida public proxy
app.get('/api/resolve/sns/:name', async (req, res) => {
  // Strip .sol suffix if present, lowercase
  const name = req.params.name.replace(/\.sol$/i, '').toLowerCase().trim();
  console.log(`🔍 Resolving SNS: ${name}.sol`);
  try {
    const r = await fetch(`https://sns-sdk-proxy.bonfida.workers.dev/resolve/${encodeURIComponent(name)}`);
    if (!r.ok) return res.status(404).json({ error: `SNS domain "${name}.sol" not found` });
    const d = await r.json();
    if (d.s === 'ok' && d.result) {
      console.log(`✅ SNS resolved: ${name}.sol → ${d.result}`);
      return res.json({ address: d.result, domain: `${name}.sol` });
    }
    res.status(404).json({ error: `SNS domain "${name}.sol" not found or not registered` });
  } catch (err) {
    console.error(`❌ SNS resolution error for ${name}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper: Resolve ADA Handle to Address
const resolveAdaHandle = async (handle) => {
  const cleanHandle = handle.replace('$', '').toLowerCase();
  try {
    const handleRes = await fetch(`https://api.handle.me/handles/${cleanHandle}`);
    if (handleRes.ok) {
      const handleData = await handleRes.json();
      if (handleData.resolved_addresses?.ada) {
        return handleData.resolved_addresses.ada;
      }
    }
    const policyId = "f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a";
    const assetNameHex = Buffer.from(cleanHandle).toString('hex');
    const assetId = policyId + assetNameHex;
    const bfRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/assets/${assetId}/addresses`, {
      headers: { 'project_id': API_KEYS.blockfrost }
    });
    if (bfRes.ok) {
      const bfData = await bfRes.json();
      if (bfData && bfData.length > 0 && bfData[0].address) {
        return bfData[0].address;
      }
    }
    return null;
  } catch (err) {
    console.error("Handle resolution error:", err);
    return null;
  }
};

app.get('/api/:mode(nfts|tokens)/cardano/:address', async (req, res) => {
  let { mode, address } = req.params;
  try {
    const isHandle = address.startsWith('$') || (!address.startsWith('addr') && !address.startsWith('stake') && /^[a-z0-9_-]+$/i.test(address));
    if (isHandle) {
      console.log(`🔍 Resolving ADA Handle: ${address}`);
      const resolvedAddress = await resolveAdaHandle(address);
      if (!resolvedAddress) {
        return res.status(404).json({ error: `Handle "${address}" not found` });
      }
      console.log(`✅ Resolved ${address} → ${resolvedAddress}`);
      address = resolvedAddress;
    }
    const adaPrice = await fetchCoinGeckoPrice('cardano');
    
    // Add cache-busting headers
    const blockfrostHeaders = { 
      'project_id': API_KEYS.blockfrost,
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    };
    
    const addrRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/addresses/${address}`, { headers: blockfrostHeaders });
    if (addrRes.status === 404) return res.json({ nfts: [] });
    const addrData = await addrRes.json();
    
    console.log(`📊 Cardano ${mode}: Processing address ${address}`);
    
    const results = [];
    
    // Add native ADA balance for tokens mode
    if (mode === 'tokens') {
      const adaLovelace = parseInt(addrData.amount?.find(a => a.unit === 'lovelace')?.quantity || 0);
      const adaBalance = adaLovelace / 1e6;
      if (adaBalance > 0) {
        results.push({
          id: 'native-ada',
          name: 'Cardano',
          symbol: 'ADA',
          balance: adaBalance.toFixed(2),
          usdPrice: adaPrice,
          nativePrice: '1.0000',
          totalValue: (adaBalance * adaPrice).toFixed(2),
          image: 'https://cryptologos.cc/logos/cardano-ada-logo.png',
          chain: 'cardano',
          isToken: true,
          metadata: { traits: [], description: '' }
        });
      }
    }
    
    // Method 1: Get assets from stake address (standard approach)
    let assets = [];
    if (addrData.stake_address) {
      const assetsRes = await fetch(
        `https://cardano-mainnet.blockfrost.io/api/v0/accounts/${addrData.stake_address}/addresses/assets`, 
        { headers: blockfrostHeaders }
      );
      assets = await assetsRes.json();
      console.log(`  Blockfrost stake assets: ${assets.length} total`);
    }
    
    // Method 2: ALSO check direct address amount field (catches BRAND NEW tokens not yet in stake endpoint)
    if (addrData.amount && Array.isArray(addrData.amount)) {
      const directAssets = addrData.amount.filter(a => a.unit !== 'lovelace' && a.quantity && parseInt(a.quantity) > 0);
      console.log(`  Direct address assets: ${directAssets.length} found`);
      
      // Merge with stake assets, preferring direct address data (fresher)
      const existingUnits = new Set(assets.map(a => a.unit));
      for (const directAsset of directAssets) {
        if (!existingUnits.has(directAsset.unit)) {
          console.log(`    ✅ Found NEW asset via direct address check: ${directAsset.unit.substring(0, 16)}...`);
          assets.push(directAsset);
        }
      }
    }
    
    console.log(`  Total unique assets to process: ${assets.length}`);
    
    // Decode Blockfrost hex asset_name → readable UTF-8
    const decodeAssetName = (hex) => {
      if (!hex) return '';
      try {
        const str = Buffer.from(hex, 'hex').toString('utf8');
        return /^[ -~]+$/.test(str) ? str.trim() : '';
      } catch { return ''; }
    };

    // Resolve image from all known Cardano metadata locations
    const resolveCardanoImage = (meta) => {
      const candidates = [
        meta.onchain_metadata?.image, meta.onchain_metadata?.logo,
        meta.onchain_metadata?.icon,
        meta.metadata?.logo,   // CIP-26 registry: base64 or URL (USDCx, HUNT, COPI live here)
        meta.metadata?.url,
      ];
      for (let img of candidates) {
        if (!img) continue;
        if (Array.isArray(img)) img = img.join('');
        if (typeof img !== 'string') continue;
        img = img.trim();
        if (!img) continue;
        if (img.startsWith('data:'))  return img;
        if (img.startsWith('ipfs://')) return `https://cloudflare-ipfs.com/ipfs/${img.slice(7)}`;
        if (img.startsWith('http'))   return img;
        if (img.length >= 46)         return `https://cloudflare-ipfs.com/ipfs/${img}`;
      }
      return '';
    };

    // Process ALL assets (removed .slice(0, 30) limit!)
    const tasks = assets.map(async (a) => {
      try {
        const metaRes = await fetch(
          `https://cardano-mainnet.blockfrost.io/api/v0/assets/${a.unit}`,
          { headers: blockfrostHeaders }
        );
        if (!metaRes.ok) return null;

        const meta = await metaRes.json();
        const isNFT = parseInt(a.quantity) === 1;
        if ((mode === 'tokens' && isNFT) || (mode === 'nfts' && !isNFT)) return null;

        // ── Name: onchain first, then decode hex asset_name ──────────────────
        const decodedName = decodeAssetName(meta.asset_name);
        let onchainName = meta.onchain_metadata?.name || meta.metadata?.name || '';
        if (Array.isArray(onchainName)) onchainName = onchainName.join('');
        const tokenName = (onchainName || decodedName || 'Cardano Asset').toString().trim();

        // ── Symbol ───────────────────────────────────────────────────────────
        const _ticker = meta.metadata?.ticker || meta.onchain_metadata?.ticker || '';
        const symbol = _ticker || decodedName.substring(0, 8) || a.unit.substring(56, 62);

        // ── Price — isolated so a failure never hides the token ───────────────
        let usdPrice = 0;
        try {
          const _cgId = NATIVE_CG_IDS[_ticker?.toUpperCase()];
          if (_cgId) usdPrice = await fetchCoinGeckoPrice(_cgId);
        } catch {}
        // Stablecoin heuristic (USDCx, iUSD, DJED, USDA…)
        if (usdPrice === 0) {
          const su = symbol.toUpperCase();
          if (su.includes('USD') || su === 'IUSD' || su === 'USDA' || su === 'DJED') usdPrice = 1.0;
        }

        // ── Image — symbol is defined before this call ────────────────────────
        let imageUrl = resolveCardanoImage(meta);
        if (!imageUrl) {
          try { imageUrl = await fetchTokenImage(symbol); } catch {}
        }

        const balance = (parseInt(a.quantity) / Math.pow(10, meta.metadata?.decimals || 0));
        const nativePrice = adaPrice > 0 ? (usdPrice / adaPrice) : 0;

        return {
          id: a.unit,
          name: tokenName,
          chain: 'cardano',
          image: imageUrl,
          balance: mode === 'tokens' ? balance.toFixed(2) : null,
          usdPrice, nativePrice: nativePrice.toFixed(4),
          totalValue: (balance * usdPrice).toFixed(2),
          symbol, isToken: mode === 'tokens',
          metadata: { traits: meta.onchain_metadata?.attributes || [], description: meta.onchain_metadata?.description || '' }
        };
      } catch (e) {
        console.error(`  Error processing asset ${a.unit}:`, e.message);
        return null;
      }
    });
    
    const taskResults = await Promise.all(tasks);
    results.push(...taskResults.filter(n => n !== null));
    
    console.log(`✅ Cardano: Returning ${results.length} ${mode}`);
    res.json({ nfts: results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- DIA Market Data Routes ---
// Top 100 cryptocurrencies with live prices
app.get('/api/market/top100', async (req, res) => {
  console.log('📊 Fetching top 100 market data...');
  
  try {
    // Use CoinGecko as it's more reliable than DIA for batch data
    const response = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h'
    );
    
    if (!response.ok) {
      throw new Error(`CoinGecko API error: ${response.status}`);
    }
    
    const data = await response.json();
    console.log(`✅ Fetched ${data.length} coins from CoinGecko`);
    
    res.json(data);
  } catch (err) {
    console.error('❌ Market data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Enhanced search with Kraken and Gemini fallback
// 10-minute search cache
const _searchCache = {};

app.get('/api/market/search/:query', async (req, res) => {
  const query = req.params.query.trim();
  const cacheKey = query.toLowerCase();
  console.log(`🔍 Search: "${query}"`);

  if (_searchCache[cacheKey] && Date.now() - _searchCache[cacheKey].ts < 600000) {
    console.log(`  📦 Cache hit: "${query}"`);
    return res.json(_searchCache[cacheKey].data);
  }

  const save = (data) => { _searchCache[cacheKey] = { data, ts: Date.now() }; return data; };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Step 1: CoinGecko /search — get slug, name, image, rank (high rate limit endpoint)
  let meta = null;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`);
    if (r.status === 429) { await sleep(3000); }
    const r2 = r.status === 429
      ? await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`)
      : r;
    if (r2.ok) {
      const d = await r2.json();
      const hit = d.coins?.[0];
      if (hit) {
        meta = { id: hit.id, name: hit.name, symbol: hit.symbol?.toUpperCase(),
                 image: hit.large || hit.thumb, rank: hit.market_cap_rank || null };
        console.log(`  ✅ /search: ${meta.name} slug="${meta.id}" rank=#${meta.rank}`);
      }
    }
  } catch (e) { console.log(`  ❌ /search: ${e.message}`); }

  // Step 2: Fetch /coins/markets AND /market_chart in parallel
  // Always fetch both — /markets may omit sparkline for smaller coins
  if (meta?.id) {
    try {
      await sleep(300);
      const [marketsRes, chartRes] = await Promise.all([
        fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${meta.id}&sparkline=true&price_change_percentage=24h`),
        fetch(`https://api.coingecko.com/api/v3/coins/${meta.id}/market_chart?vs_currency=usd&days=7`)
      ]);

      // Extract sparkline from market_chart (more reliable than markets sparkline for smaller coins)
      let sparklineFromChart = null;
      if (chartRes.ok) {
        const cd = await chartRes.json();
        const pts = (cd.prices || []).map(([, p]) => p);
        if (pts.length > 0) sparklineFromChart = { price: pts };
        console.log(`  ✅ market_chart: ${pts.length} sparkline points`);
      }

      // Use /markets data if available, always override sparkline with chart data
      if (marketsRes.ok) {
        const d = await marketsRes.json();
        if (d?.length > 0) {
          const coin = {
            ...d[0],
            source: 'CoinGecko',
            symbol: d[0].symbol.toUpperCase(),
            market_cap_rank: d[0].market_cap_rank || meta.rank,
            image: d[0].image || meta.image,
            // Use chart sparkline — it's always populated, markets sparkline can be null
            sparkline_in_7d: sparklineFromChart || d[0].sparkline_in_7d,
          };
          console.log(`  ✅ Full result: ${coin.name} #${coin.market_cap_rank} $${coin.current_price} sparkline=${!!coin.sparkline_in_7d}`);
          return res.json(save(coin));
        }
      }

      // /markets rate-limited or failed — build from meta + simple/price + chart
      if (marketsRes.status === 429 || !marketsRes.ok) {
        console.log('  ⚠️ /markets unavailable — assembling from simple/price + chart');
        await sleep(1000);
        const priceRes = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${meta.id}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`
        );
        if (priceRes.ok) {
          const pd = await priceRes.json();
          const price = pd[meta.id]?.usd;
          if (price) {
            const coin = {
              id: meta.id, name: meta.name, symbol: meta.symbol,
              current_price: price,
              price_change_percentage_24h: pd[meta.id]?.usd_24h_change || 0,
              market_cap: pd[meta.id]?.usd_market_cap || 0,
              market_cap_rank: meta.rank,
              image: meta.image,
              sparkline_in_7d: sparklineFromChart,
              total_volume: 0, high_24h: 0, low_24h: 0,
              source: 'CoinGecko',
            };
            console.log(`  ✅ Assembled: ${coin.name} #${coin.market_cap_rank} $${price} sparkline=${!!sparklineFromChart}`);
            return res.json(save(coin));
          }
        }
      }
    } catch (e) { console.log(`  ❌ CoinGecko data fetch: ${e.message}`); }
  }

  // Step 3: Kraken (major coins, ticker only)
  const ticker = meta?.symbol || query.toUpperCase();
  try {
    const r = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${ticker}USD`);
    const d = await r.json();
    if (d.result && Object.keys(d.result).length > 0) {
      const tk = d.result[Object.keys(d.result)[0]];
      const price = parseFloat(tk.c[0]);
      const coin = {
        id: meta?.id || query.toLowerCase(), name: meta?.name || ticker, symbol: ticker,
        current_price: price,
        price_change_percentage_24h: ((price - parseFloat(tk.o)) / parseFloat(tk.o)) * 100,
        high_24h: parseFloat(tk.h[1]), low_24h: parseFloat(tk.l[1]),
        total_volume: parseFloat(tk.v[1]), market_cap: 0,
        market_cap_rank: meta?.rank || null,
        image: meta?.image || `https://assets.coingecko.com/coins/images/1/small/bitcoin.png`,
        sparkline_in_7d: null, source: 'Kraken',
      };
      console.log(`  ✅ Kraken: ${ticker} $${price}`);
      return res.json(save(coin));
    }
  } catch (e) { console.log(`  ❌ Kraken: ${e.message}`); }

  // Step 4: Gemini
  try {
    const r = await fetch(`https://api.gemini.com/v1/pubticker/${ticker.toLowerCase()}usd`);
    if (r.ok) {
      const d = await r.json();
      const price = parseFloat(d.last);
      if (price > 0) {
        const coin = {
          id: meta?.id || query.toLowerCase(), name: meta?.name || ticker, symbol: ticker,
          current_price: price, price_change_percentage_24h: 0,
          market_cap: 0, market_cap_rank: meta?.rank || null,
          image: meta?.image || `https://assets.coingecko.com/coins/images/1/small/bitcoin.png`,
          sparkline_in_7d: null, source: 'Gemini',
        };
        console.log(`  ✅ Gemini: ${ticker} $${price}`);
        return res.json(save(coin));
      }
    }
  } catch (e) { console.log(`  ❌ Gemini: ${e.message}`); }

  res.status(404).json({ error: `"${query}" not found. Try full name (e.g. "Monad") or ticker (e.g. "MON")` });
});

// Enhanced chart with multiple timeframes and Kraken/Gemini fallback
app.get('/api/market/chart/:coinIdOrSymbol', async (req, res) => {
  const input = req.params.coinIdOrSymbol.toLowerCase();
  const timeframe = req.query.timeframe || '7d';
  console.log(`📈 Fetching chart for: ${input} (${timeframe})`);
  
  // CoinGecko ID to trading symbol mapping (for Binance/Kraken/Gemini)
  const idToSymbol = {
    'bitcoin': 'BTC', 'ethereum': 'ETH', 'tether': 'USDT', 'binancecoin': 'BNB',
    'solana': 'SOL', 'usd-coin': 'USDC', 'ripple': 'XRP', 'dogecoin': 'DOGE',
    'the-open-network': 'TON', 'cardano': 'ADA', 'avalanche-2': 'AVAX',
    'shiba-inu': 'SHIB', 'polkadot': 'DOT', 'chainlink': 'LINK', 'tron': 'TRX',
    'matic-network': 'MATIC', 'dai': 'DAI', 'litecoin': 'LTC', 'bitcoin-cash': 'BCH',
    'uniswap': 'UNI', 'cosmos': 'ATOM', 'stellar': 'XLM',
    'internet-computer': 'ICP', 'filecoin': 'FIL', 'aptos': 'APT',
    'hedera-hashgraph': 'HBAR', 'arbitrum': 'ARB', 'vechain': 'VET',
    'near': 'NEAR', 'optimism': 'OP', 'injective-protocol': 'INJ',
    'the-graph': 'GRT', 'fantom': 'FTM', 'algorand': 'ALGO',
    'aave': 'AAVE', 'ethereum-classic': 'ETC', 'monad': 'MON'
  };
  
  // Symbol to CoinGecko ID mapping (reverse)
  const symbolToId = {
    'btc': 'bitcoin', 'eth': 'ethereum', 'usdt': 'tether', 'bnb': 'binancecoin',
    'sol': 'solana', 'usdc': 'usd-coin', 'xrp': 'ripple', 'doge': 'dogecoin',
    'ton': 'the-open-network', 'ada': 'cardano', 'avax': 'avalanche-2',
    'shib': 'shiba-inu', 'dot': 'polkadot', 'link': 'chainlink', 'trx': 'tron',
    'matic': 'matic-network', 'dai': 'dai', 'ltc': 'litecoin', 'bch': 'bitcoin-cash',
    'uni': 'uniswap', 'atom': 'cosmos', 'xlm': 'stellar',
    'icp': 'internet-computer', 'fil': 'filecoin', 'apt': 'aptos',
    'hbar': 'hedera-hashgraph', 'arb': 'arbitrum', 'vet': 'vechain',
    'near': 'near', 'op': 'optimism', 'inj': 'injective-protocol',
    'grt': 'the-graph', 'ftm': 'fantom', 'algo': 'algorand',
    'aave': 'aave', 'etc': 'ethereum-classic', 'mon': 'monad'
  };
  
  const coinId = symbolToId[input] || input;
  const symbol = idToSymbol[coinId] || input.toUpperCase();
  
  // Timeframe configuration
  const getTimeframeConfig = (tf) => {
    switch(tf) {
      case '1d':
        return { days: 1, binanceInterval: '5m', binanceLimit: 288, krakenInterval: 5, geminiTimeframe: '5m' };
      case '7d':
        return { days: 7, binanceInterval: '1h', binanceLimit: 168, krakenInterval: 60, geminiTimeframe: '1hr' };
      case '1m':
        return { days: 30, binanceInterval: '4h', binanceLimit: 180, krakenInterval: 240, geminiTimeframe: '6hr' };
      case '1y':
        return { days: 365, binanceInterval: '1d', binanceLimit: 365, krakenInterval: 1440, geminiTimeframe: '1day' };
      case 'all':
        return { days: 'max', binanceInterval: '1w', binanceLimit: 1000, krakenInterval: 10080, geminiTimeframe: '1day' };
      default:
        return { days: 7, binanceInterval: '1h', binanceLimit: 168, krakenInterval: 60, geminiTimeframe: '1hr' };
    }
  };
  
  const config = getTimeframeConfig(timeframe);
  
  try {
    // Step 1: Try Binance
    console.log('  📊 Trying Binance...');
    try {
      const binanceSymbol = symbol + 'USDT';
      const binanceUrl = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${config.binanceInterval}&limit=${config.binanceLimit}`;
      const binanceRes = await fetch(binanceUrl);
      const binanceData = await binanceRes.json();
      
      if (binanceRes.ok && Array.isArray(binanceData) && binanceData.length > 0) {
        const formattedPrices = binanceData.map(k => ({
          time: k[0],
          price: parseFloat(k[4])
        }));
        
        const currentPrice = formattedPrices[formattedPrices.length - 1].price;
        const startPrice = formattedPrices[0].price;
        const change = ((currentPrice - startPrice) / startPrice) * 100;
        
        console.log(`  ✅ Binance: ${formattedPrices.length} data points`);
        return res.json({
          symbol: symbol,
          name: input.toUpperCase(),
          prices: formattedPrices,
          current_price: currentPrice,
          change_24h: change,
          source: 'Binance',
          timeframe: timeframe
        });
      } else {
        console.log(`  ❌ Binance failed: ${binanceData.msg || 'Symbol not found'}`);
      }
    } catch (e) {
      console.log(`  ❌ Binance error: ${e.message}`);
    }
    
    // Step 2: Try Kraken
    console.log('  🐙 Trying Kraken...');
    try {
      const krakenSymbol = symbol + 'USD';
      const krakenUrl = `https://api.kraken.com/0/public/OHLC?pair=${krakenSymbol}&interval=${config.krakenInterval}`;
      const krakenRes = await fetch(krakenUrl);
      const krakenData = await krakenRes.json();
      
      if (krakenData.result && Object.keys(krakenData.result).length > 0) {
        const pairKey = Object.keys(krakenData.result).find(k => k !== 'last');
        if (pairKey) {
          const ohlcData = krakenData.result[pairKey];
          const formattedPrices = ohlcData.slice(-config.binanceLimit).map(candle => ({
            time: candle[0] * 1000,
            price: parseFloat(candle[4])
          }));
          
          const currentPrice = formattedPrices[formattedPrices.length - 1].price;
          const startPrice = formattedPrices[0].price;
          const change = ((currentPrice - startPrice) / startPrice) * 100;
          
          console.log(`  ✅ Kraken: ${formattedPrices.length} data points`);
          return res.json({
            symbol: symbol,
            name: input.toUpperCase(),
            prices: formattedPrices,
            current_price: currentPrice,
            change_24h: change,
            source: 'Kraken',
            timeframe: timeframe
          });
        }
      }
      console.log(`  ❌ Kraken failed: ${krakenData.error?.[0] || 'Pair not found'}`);
    } catch (e) {
      console.log(`  ❌ Kraken error: ${e.message}`);
    }
    
    // Step 3: Try Gemini
    console.log('  💎 Trying Gemini...');
    try {
      const geminiSymbol = symbol.toLowerCase() + 'usd';
      const geminiUrl = `https://api.gemini.com/v2/candles/${geminiSymbol}/${config.geminiTimeframe}`;
      const geminiRes = await fetch(geminiUrl);
      const geminiData = await geminiRes.json();
      
      if (geminiRes.ok && Array.isArray(geminiData) && geminiData.length > 0) {
        const formattedPrices = geminiData.slice(-config.binanceLimit).reverse().map(candle => ({
          time: candle[0],
          price: parseFloat(candle[4])
        }));
        
        const currentPrice = formattedPrices[formattedPrices.length - 1].price;
        const startPrice = formattedPrices[0].price;
        const change = ((currentPrice - startPrice) / startPrice) * 100;
        
        console.log(`  ✅ Gemini: ${formattedPrices.length} data points`);
        return res.json({
          symbol: symbol,
          name: input.toUpperCase(),
          prices: formattedPrices,
          current_price: currentPrice,
          change_24h: change,
          source: 'Gemini',
          timeframe: timeframe
        });
      } else {
        console.log(`  ❌ Gemini failed: ${geminiData.message || 'Symbol not found'}`);
      }
    } catch (e) {
      console.log(`  ❌ Gemini error: ${e.message}`);
    }
    
    // Step 4: Try CoinGecko
    console.log('  🦎 Trying CoinGecko...');
    try {
      const cgUrl = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${config.days}`;
      const cgRes = await fetch(cgUrl);
      const cgData = await cgRes.json();
      
      if (cgRes.ok && cgData.prices && cgData.prices.length > 0) {
        const formattedPrices = cgData.prices.map(([time, price]) => ({
          time,
          price
        }));
        
        const currentPrice = formattedPrices[formattedPrices.length - 1].price;
        const yesterdayPrice = formattedPrices[Math.max(0, formattedPrices.length - 25)]?.price || currentPrice;
        const change = ((currentPrice - yesterdayPrice) / yesterdayPrice) * 100;
        
        console.log(`  ✅ CoinGecko: ${formattedPrices.length} data points`);
        return res.json({
          symbol: symbol,
          name: coinId,
          prices: formattedPrices,
          current_price: currentPrice,
          change_24h: change,
          source: 'CoinGecko',
          timeframe: timeframe
        });
      } else {
        console.log(`  ❌ CoinGecko failed: ${cgData.error || cgData.status?.error_message || 'No data'}`);
      }
    } catch (e) {
      console.log(`  ❌ CoinGecko error: ${e.message}`);
    }
    
    // No data from any source
    console.log(`  ❌ No chart data available from any source`);
    return res.status(404).json({ error: `No chart data available for ${input}` });
    
  } catch (err) {
    console.error(`❌ Chart error for ${input}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Transaction History Routes ---
console.log('🔧 Setting up transaction history routes...');

// Native currency mapping
const nativeCurrencies = {
  'ethereum': 'ETH', 'base': 'ETH', 'optimism': 'ETH', 'arbitrum': 'ETH',
  'zora': 'ETH', 'blast': 'ETH', 'abstract': 'ETH', 'worldchain': 'ETH',
  'soneium': 'ETH', 'polygon': 'MATIC', 'avalanche': 'AVAX',
  'apechain': 'APE', 'ronin': 'RON', 'monad': 'MON',
  'gnosis': 'xDAI', 'hyperevm': 'HYPE',
  'solana': 'SOL', 'cardano': 'ADA'
};

// EVM chains transaction history using Alchemy - OPTIMIZED BLOCK TIMESTAMPS
console.log(`🔗 Setting up transaction routes for ${evmChains.length} EVM chains:`, evmChains.map(c => c.id).join(', '));

evmChains.forEach(chain => {
  console.log(`  ✅ Registered: /api/transactions/${chain.id}/:address`);
  
  app.get(`/api/transactions/${chain.id}/:address`, async (req, res) => {
    const { address } = req.params;
    console.log(`📜 Fetching ${chain.id} transactions for: ${address}`);
    
    try {
      const baseUrl = `https://${chain.net}.g.alchemy.com/v2/${API_KEYS.alchemy}`;
      
      // Get sent transactions
      const sentRes = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'alchemy_getAssetTransfers',
          params: [{
            fromBlock: '0x0',
            toBlock: 'latest',
            fromAddress: address,
            category: ['external', 'internal', 'erc20'],
            maxCount: '0x32',
            order: 'desc'
          }]
        })
      });
      
      const sentData = await sentRes.json();
      
      // Get received transactions
      const receivedRes = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'alchemy_getAssetTransfers',
          params: [{
            fromBlock: '0x0',
            toBlock: 'latest',
            toAddress: address,
            category: ['external', 'internal', 'erc20'],
            maxCount: '0x32',
            order: 'desc'
          }]
        })
      });
      
      const receivedData = await receivedRes.json();
      
      // Combine all transfers
      const allTransfers = [
        ...(sentData.result?.transfers || []).map(tx => ({ ...tx, type: 'sent' })),
        ...(receivedData.result?.transfers || []).map(tx => ({ 
          ...tx, 
          type: tx.from.toLowerCase() === address.toLowerCase() ? 'self' : 'received' 
        }))
      ].filter(tx => tx.value && parseFloat(tx.value) > 0 && tx.blockNum);
      
      // Get unique block numbers
      const uniqueBlocks = [...new Set(allTransfers.map(tx => tx.blockNum))];
      console.log(`📦 ${chain.id}: Fetching ${uniqueBlocks.length} unique blocks for ${allTransfers.length} transactions`);
      
      // Batch fetch all unique blocks (much more efficient!)
      const blockTimestamps = {};
      await Promise.all(
        uniqueBlocks.slice(0, 30).map(async (blockNum) => {
          try {
            const blockRes = await fetch(baseUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 3,
                method: 'eth_getBlockByNumber',
                params: [blockNum, false]
              })
            });
            
            const blockData = await blockRes.json();
            if (blockData.result && blockData.result.timestamp) {
              const timestamp = parseInt(blockData.result.timestamp, 16) * 1000;
              blockTimestamps[blockNum] = timestamp;
            }
          } catch (e) {
            console.log(`⚠️ ${chain.id}: Error fetching block ${blockNum}`);
          }
        })
      );
      
      // Map timestamps to transactions
      const allTxs = allTransfers
        .slice(0, 50)
        .map(tx => {
          const timestamp = blockTimestamps[tx.blockNum];
          if (!timestamp) {
            console.log(`⚠️ ${chain.id}: No timestamp for block ${tx.blockNum}, skipping tx`);
            return null;
          }
          
          return {
            hash: tx.hash,
            type: tx.type,
            from: tx.from,
            to: tx.to,
            value: parseFloat(tx.value),
            asset: tx.asset || nativeCurrencies[chain.id] || 'ETH',
            category: tx.category,
            timestamp: timestamp,
            chain: chain.id,
            rawContract: tx.rawContract
          };
        })
        .filter(tx => tx !== null)
        .sort((a, b) => b.timestamp - a.timestamp);
      
      console.log(`✅ ${chain.id}: Found ${allTxs.length} transactions with real timestamps`);
      res.json({ transactions: allTxs });
      
    } catch (err) {
      console.error(`❌ ${chain.id} transaction error:`, err.message);
      res.json({ transactions: [] });
    }
  });
});

// Solana transactions using Helius Enhanced API
app.get('/api/transactions/solana/:address', async (req, res) => {
  const { address } = req.params;
  console.log(`\n========================================`);
  console.log(`📜 SOLANA TX FETCH START`);
  console.log(`Address: ${address}`);
  console.log(`Helius Key: ${API_KEYS.helius ? 'Present' : 'MISSING!'}`);
  
  try {
    // Use Helius Enhanced Transactions API for parsed data
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${API_KEYS.helius}&limit=50`;
    console.log(`🔗 Calling Enhanced API: ${url.replace(API_KEYS.helius, 'KEY')}`);
    
    const response = await fetch(url);
    console.log(`📥 Response status: ${response.status}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ API Error ${response.status}:`, errorText.substring(0, 200));
      return res.json({ transactions: [] });
    }
    
    const txList = await response.json();
    console.log(`📦 Response type:`, Array.isArray(txList) ? 'Array' : 'Object');
    console.log(`📝 Total transactions returned: ${txList.length || 0}`);
    
    if (!Array.isArray(txList) || txList.length === 0) {
      console.log(`⚠️ No transactions found`);
      return res.json({ transactions: [] });
    }
    
    console.log(`📝 Sample transaction structure:`, Object.keys(txList[0]));
    
    // Parse Helius enhanced transactions and filter
    const transactions = txList
      .map(tx => {
        // Helius provides parsed native transfers
        const nativeTransfers = tx.nativeTransfers || [];
        const tokenTransfers = tx.tokenTransfers || [];
        
        // Find transfers involving our address
        const ourNativeTransfer = nativeTransfers.find(t => 
          t.fromUserAccount === address || t.toUserAccount === address
        );
        
        let type = 'unknown';
        let value = 0;
        let asset = 'SOL';
        
        if (ourNativeTransfer) {
          value = ourNativeTransfer.amount / 1e9; // Convert lamports to SOL
          type = ourNativeTransfer.fromUserAccount === address ? 'sent' : 'received';
          asset = 'SOL';
        } else if (tokenTransfers.length > 0) {
          // Token transfer
          const ourTokenTransfer = tokenTransfers.find(t =>
            t.fromUserAccount === address || t.toUserAccount === address
          );
          if (ourTokenTransfer) {
            value = ourTokenTransfer.tokenAmount || 0;
            type = ourTokenTransfer.fromUserAccount === address ? 'sent' : 'received';
            asset = ourTokenTransfer.mint ? ourTokenTransfer.mint.substring(0, 8) : 'TOKEN';
          }
        }
        
        // Must have valid timestamp
        if (!tx.timestamp) {
          console.log(`⚠️ Solana: Skipping tx ${tx.signature} - no timestamp`);
          return null;
        }
        
        // Must have type and value (skip unknown/NFT transactions)
        if (type === 'unknown' || value === 0) {
          console.log(`⚠️ Solana: Skipping tx ${tx.signature} - type: ${type}, value: ${value}`);
          return null;
        }
        
        return {
          hash: tx.signature,
          type: type,
          from: type === 'received' ? '' : address,
          to: type === 'sent' ? '' : address,
          value: value,
          asset: asset,
          category: 'transaction',
          timestamp: tx.timestamp * 1000,
          chain: 'solana',
          fee: tx.fee ? tx.fee / 1e9 : 0
        };
      })
      .filter(tx => tx !== null); // Remove nulls
    
    console.log(`✅ Returning ${transactions.length} parsed transactions (filtered)`);
    if (transactions.length > 0) {
      console.log(`📝 Sample parsed tx:`, transactions[0]);
    }
    console.log(`========================================\n`);
    res.json({ transactions });
    
  } catch (err) {
    console.error(`❌ SOLANA TX ERROR:`, err.message);
    console.error(`Stack:`, err.stack);
    console.log(`========================================\n`);
    res.json({ transactions: [] });
  }
});

// Cardano transactions using Blockfrost
app.get('/api/transactions/cardano/:address', async (req, res) => {
  const { address } = req.params;
  console.log(`📜 Fetching Cardano transactions for: ${address}`);
  
  try {
    const response = await fetch(
      `https://cardano-mainnet.blockfrost.io/api/v0/addresses/${address}/transactions?count=50&order=desc`,
      { headers: { project_id: API_KEYS.blockfrost } }
    );
    
    if (!response.ok) {
      return res.json({ transactions: [] });
    }
    
    const txHashes = await response.json();
    
    // Get details for each transaction (limit to first 20 for performance)
    const txDetails = await Promise.all(
      txHashes.slice(0, 20).map(async (tx) => {
        try {
          // Fetch transaction details
          const detailRes = await fetch(
            `https://cardano-mainnet.blockfrost.io/api/v0/txs/${tx.tx_hash}`,
            { headers: { project_id: API_KEYS.blockfrost } }
          );
          const detail = await detailRes.json();
          
          // Fetch UTXOs to determine sent/received
          const utxoRes = await fetch(
            `https://cardano-mainnet.blockfrost.io/api/v0/txs/${tx.tx_hash}/utxos`,
            { headers: { project_id: API_KEYS.blockfrost } }
          );
          const utxo = await utxoRes.json();
          
          // Calculate total input from our address
          const inputAmount = (utxo.inputs || [])
            .filter(input => input.address === address)
            .reduce((sum, input) => {
              const lovelace = input.amount.find(a => a.unit === 'lovelace');
              return sum + parseInt(lovelace?.quantity || 0);
            }, 0);
          
          // Calculate total output to our address
          const outputAmount = (utxo.outputs || [])
            .filter(output => output.address === address)
            .reduce((sum, output) => {
              const lovelace = output.amount.find(a => a.unit === 'lovelace');
              return sum + parseInt(lovelace?.quantity || 0);
            }, 0);
          
          const fee = parseFloat(detail.fees || 0);
          
          // Determine type and value
          let type = 'unknown';
          let value = 0;
          
          if (inputAmount > 0 && outputAmount === 0) {
            // Sent all out
            type = 'sent';
            value = (inputAmount - fee) / 1e6;
          } else if (inputAmount === 0 && outputAmount > 0) {
            // Received
            type = 'received';
            value = outputAmount / 1e6;
          } else if (inputAmount > outputAmount) {
            // Sent (partial)
            type = 'sent';
            value = (inputAmount - outputAmount - fee) / 1e6;
          } else if (outputAmount > inputAmount) {
            // Received (partial)
            type = 'received';
            value = (outputAmount - inputAmount) / 1e6;
          } else {
            // Self-transfer
            type = 'self';
            value = (fee) / 1e6;
          }
          
          // Skip if value is negligible
          if (value < 0.01) return null;
          
          return {
            hash: tx.tx_hash,
            type: type,
            from: type === 'received' ? '' : address,
            to: type === 'sent' ? '' : address,
            value: value,
            asset: 'ADA',
            category: 'transaction',
            timestamp: detail.block_time * 1000,
            chain: 'cardano',
            fee: fee / 1e6
          };
        } catch (e) {
          return null;
        }
      })
    );
    
    const transactions = txDetails.filter(tx => tx !== null);
    
    console.log(`✅ Cardano: Found ${transactions.length} transactions`);
    res.json({ transactions });
    
  } catch (err) {
    console.error(`❌ Cardano transaction error:`, err.message);
    res.json({ transactions: [] });
  }
});

// Monad transactions using Moralis API
app.get('/api/transactions/monad/:address', async (req, res) => {
  const { address } = req.params;
  console.log(`\n========================================`);
  console.log(`📜 MONAD TX FETCH START`);
  console.log(`Address: ${address}`);
  console.log(`Moralis Key: ${API_KEYS.moralis ? 'Present' : 'MISSING!'}`);
  
  try {
    if (!API_KEYS.moralis) {
      console.error('❌ MORALIS_KEY is missing from .env!');
      return res.json({ transactions: [] });
    }
    
    // Try the wallet history endpoint (v2.2)
    const url = `https://deep-index.moralis.io/api/v2.2/${address}/history?chain=0x8f&order=DESC&limit=50`;
    console.log(`🔗 Calling: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'accept': 'application/json',
        'X-API-Key': API_KEYS.moralis
      }
    });
    
    console.log(`📥 Response status: ${response.status}`);
    
    if (!response.ok) {
      console.log(`⚠️ Monad not supported by Moralis yet (chain 0x8f)`);
      console.log(`========================================\n`);
      return res.json({ transactions: [] });
    }
    
    const data = await response.json();
    console.log(`📦 Response keys:`, Object.keys(data));
    
    const txList = data.result || data.transactions || [];
    console.log(`📝 Transaction count: ${txList.length}`);
    
    if (txList.length === 0) {
      console.log(`⚠️ No Monad transactions found`);
      console.log(`========================================\n`);
      return res.json({ transactions: [] });
    }
    
    const transactions = txList
      .filter(tx => {
        // Must have timestamp
        if (!tx.block_timestamp) {
          console.log(`⚠️ Monad: Skipping tx without timestamp`);
          return false;
        }
        return true;
      })
      .map(tx => {
        const isSent = tx.from_address?.toLowerCase() === address.toLowerCase();
        const value = parseFloat(tx.value || 0) / 1e18;
        
        return {
          hash: tx.hash || tx.transaction_hash,
          type: isSent ? 'sent' : 'received',
          from: tx.from_address || '',
          to: tx.to_address || '',
          value: value,
          asset: 'MON',
          category: 'transaction',
          timestamp: new Date(tx.block_timestamp).getTime(),
          chain: 'monad',
          fee: 0
        };
      });
    
    console.log(`✅ Returning ${transactions.length} transactions`);
    console.log(`========================================\n`);
    res.json({ transactions });
    
  } catch (err) {
    console.error(`❌ MONAD TX ERROR:`, err.message);
    console.error(`Stack:`, err.stack);
    console.log(`========================================\n`);
    res.json({ transactions: [] });
  }
});

console.log('✅ Transaction history routes configured');

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// Validate critical API keys at startup
if (!API_KEYS.alchemy) {
  console.error('⚠️  WARNING: ALCHEMY_KEY not found in .env file!');
  console.error('   EVM chains (Ethereum, Optimism, etc.) will not work without it.');
} else {
  console.log('✅ Alchemy API key loaded');
}

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));