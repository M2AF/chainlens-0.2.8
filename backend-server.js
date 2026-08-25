require('dotenv').config({ path: __dirname + '/.env' });
const _envCheck = { moralis: !!process.env.MORALIS_KEY, alchemy: !!process.env.ALCHEMY_KEY, cwd: process.cwd(), dir: __dirname };
console.log('🔑 ENV check:', JSON.stringify(_envCheck));
const express = require('express');
const cors = require('cors');
// Use Node's built-in fetch (undici) — avoids node-fetch v2's "Premature close"
// bug on Node 24.17+ keep-alive sockets. Falls back to node-fetch only on <18.
const fetch = globalThis.fetch || ((...args) => import('node-fetch').then(m => m.default(...args)));
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const {
  EVM_CHAINS: SCANNER_EVM_CHAINS,
  DEFAULT_CHAINS: SCANNER_CHAINS,
  PROFILE_WALLET_MAP,
  validateProfileWalletAddress,
  normalizeProfileWalletAddress,
} = require('./public/chain-catalog');
const { createNonEvmScanner } = require('./non-evm-scanner');
const {
  isUuid, orderedFriendPair, normalizeChatContent,
  summarizeChatUnread, chatConversationKey, WORLD_CONVERSATION,
} = require('./chat-service');
const { resolveWalletSession } = require('./auth-session');

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
let ethersLib = null;
try {
  const { ethers } = require('ethers');
  ethersLib = ethers;
  // Works for both ethers v5 (utils.verifyMessage) and v6 (verifyMessage)
  ethersVerify = ethers.verifyMessage
    ? (msg, sig) => ethers.verifyMessage(msg, sig)
    : (msg, sig) => ethers.utils.verifyMessage(msg, sig);
  console.log('✅ ethers loaded for EVM signature verification');
} catch (e) { console.warn('⚠️  ethers not installed — EVM sig verification skipped'); }

// ─── Abstract Global Wallet: derive smart account address from EOA ────────────
// Uses the AGW factory contract on Abstract mainnet — no extra packages needed.
// Docs: https://docs.abs.xyz/abstract-global-wallet/agw-client/getSmartAccountAddressFromInitialSigner
const AGW_FACTORY = '0xe86Bf72715dF28a0b7c3C8F596E7fE05a22A139c';
const AGW_FACTORY_ABI = ['function getAddressForSalt(bytes32 salt) view returns (address)'];
const ABSTRACT_RPC = 'https://api.mainnet.abs.xyz';

const deriveAGWAddress = async (eoaAddress) => {
  if (!ethersLib) return null;
  try {
    // ethers v5 vs v6 compat
    const provider = ethersLib.JsonRpcProvider
      ? new ethersLib.JsonRpcProvider(ABSTRACT_RPC)              // v6
      : new ethersLib.providers.JsonRpcProvider(ABSTRACT_RPC);   // v5
    const factory = new ethersLib.Contract(AGW_FACTORY, AGW_FACTORY_ABI, provider);
    // Salt = keccak256(toBytes(eoaAddress)) — same as agw-client source
    const salt = ethersLib.keccak256
      ? ethersLib.keccak256(ethersLib.getBytes(eoaAddress))      // v6
      : ethersLib.utils.keccak256(ethersLib.utils.arrayify(eoaAddress)); // v5
    const agwAddress = await factory.getAddressForSalt(salt);
    console.log(`⚡ AGW address derived for ${eoaAddress.slice(0,10)}… → ${agwAddress}`);
    return agwAddress;
  } catch (e) {
    console.warn('⚠️  AGW address derivation failed:', e.message);
    return null;
  }
};

// ─── SimpleWebAuthn for passkey (WebAuthn) sign-in ────────────────────────────
// Optional, like every other verifier here: if the dep is missing the passkey
// routes report themselves unavailable and the UI hides the buttons, rather
// than the server failing to boot.
let webauthn = null;
try { webauthn = require('@simplewebauthn/server'); console.log('✅ @simplewebauthn/server loaded'); }
catch (e) { console.warn('⚠️  @simplewebauthn/server not installed — passkey sign-in disabled'); }

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

// ─── WebAuthn relying-party identity ─────────────────────────────────────────
// rpID is the DOMAIN a passkey is bound to, and it is permanent: changing it
// orphans every passkey already registered. Default to the registrable domain
// (apex, no "www.") so a passkey made on www.chainlensnft.info still works on
// chainlensnft.info and vice-versa — the browser accepts an rpID that is the
// page origin or a registrable suffix of it.
const RP_NAME = 'ChainLens';
const RP_PROD_DOMAIN = 'chainlensnft.info';
const RP_ID = process.env.WEBAUTHN_RP_ID || (() => {
  let host = null;
  try { host = new URL(FRONTEND_URL).hostname.replace(/^www\./, ''); } catch { /* malformed */ }
  // FRONTEND_URL defaults to http://localhost:10000 when unset, so a deploy that
  // forgot it would bind every passkey to "localhost" — credentials that can
  // never be used on the real site, and unfixable afterwards. In production the
  // real domain always wins over that fallback.
  const isLoopback = !host || host === 'localhost' || host === '127.0.0.1';
  if (isLoopback && process.env.NODE_ENV === 'production') return RP_PROD_DOMAIN;
  return host || RP_PROD_DOMAIN;
})();
// Origins the assertion may legitimately come from. Unlike rpID this is an
// exact match, so both hostnames must be listed explicitly.
const RP_ORIGINS = (() => {
  const fromEnv = (process.env.WEBAUTHN_ORIGINS || '')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  const set = new Set();
  try { set.add(new URL(FRONTEND_URL).origin); } catch { /* malformed FRONTEND_URL */ }
  if (RP_ID !== 'localhost') { set.add(`https://${RP_ID}`); set.add(`https://www.${RP_ID}`); }
  return [...set];
})();
if (webauthn) {
  console.log(`🔐 Passkey RP: id=${RP_ID} origins=${RP_ORIGINS.join(' ')}`);
  // rpID is baked into every credential and cannot be changed later without
  // orphaning them all, so a mismatch between it and the site's own origins is
  // worth shouting about rather than discovering months later.
  if (!RP_ORIGINS.some(o => { try { return new URL(o).hostname === RP_ID || new URL(o).hostname.endsWith(`.${RP_ID}`); } catch { return false; } })) {
    console.error(`❌ WEBAUTHN_RP_ID "${RP_ID}" does not match any allowed origin (${RP_ORIGINS.join(' ')}) — passkey ceremonies will be rejected by the browser. Set WEBAUTHN_RP_ID / WEBAUTHN_ORIGINS.`);
  }
}

// ─── In-memory nonce store (auto-cleaned every 5 min) ────────────────────────
const _authNonces = {}; // { address_lower: { nonce, expires } }
const _oauthStates = {}; // { state: { expires } }
// { ceremonyId: { challenge, userId|null, expires } } — a WebAuthn challenge is
// single-use and short-lived; holding it server-side is what stops a replay.
const _passkeyChallenges = {};
setInterval(() => {
  const now = Date.now();
  Object.keys(_authNonces).forEach(k => { if (_authNonces[k].expires < now) delete _authNonces[k]; });
  Object.keys(_oauthStates).forEach(k => { if (_oauthStates[k].expires < now) delete _oauthStates[k]; });
  Object.keys(_passkeyChallenges).forEach(k => { if (_passkeyChallenges[k].expires < now) delete _passkeyChallenges[k]; });
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

// Upsert a social login record linked to a user_id
const dbLinkSocialAccount = async (userId, { provider, provider_id, display_name, avatar_url, email }) => {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('cl_linked_accounts')
    .upsert(
      { user_id: userId, provider, provider_id, display_name, avatar_url, email },
      { onConflict: 'provider,provider_id' }
    )
    .select().single();
  if (error) throw error;
  return data;
};

// Find an existing user who already has this social account linked
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

const dbLinkWallet = async (userId, { chain, address, watch_only = false }) => {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('cl_wallets')
    .upsert({ user_id: userId, chain, address, watch_only, verified_at: new Date().toISOString() },
             { onConflict: 'user_id,address' })
    .select().single();
  if (error) throw error;
  return data;
};

// ─── Passkey (cl_passkeys) helpers ───────────────────────────────────────────
// Every one of these can fail with "relation does not exist" until the operator
// runs sql/cl_passkeys.sql, so callers treat a throw as "passkeys unavailable"
// rather than letting it surface as a 500.
const dbListPasskeys = async (userId) => {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('cl_passkeys')
    .select('id, credential_id, transports, device_type, backed_up, label, created_at, last_used_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
};

const dbFindPasskey = async (credentialId) => {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('cl_passkeys')
    .select('*')
    .eq('credential_id', credentialId)
    .maybeSingle();
  if (error) throw error;
  return data;
};

const dbInsertPasskey = async (userId, passkey) => {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('cl_passkeys')
    .insert({ user_id: userId, ...passkey })
    .select().single();
  if (error) throw error;
  return data;
};

const dbTouchPasskey = async (id, counter) => {
  if (!supabase) return;
  await supabase.from('cl_passkeys')
    .update({ counter, last_used_at: new Date().toISOString() })
    .eq('id', id);
};

// Scoped to user_id so one account can never delete another's passkey.
const dbDeletePasskey = async (userId, id) => {
  if (!supabase) return;
  const { error } = await supabase.from('cl_passkeys')
    .delete().eq('id', id).eq('user_id', userId);
  if (error) throw error;
};

// ─── ChainLens Messenger helpers ─────────────────────────────────────────────
// Chat stays behind the existing ChainLens JWT boundary. The browser never
// talks to these Supabase tables directly; the service-role client below is the
// only database caller, and cl_chat.sql enables RLS with no client policies.
const CHAT_PROFILE_COLUMNS = 'id, display_name, avatar_url';
const CHAT_INITIAL_PAGE = 60;
const CHAT_POLL_PAGE = 100;

const dbGetChatEligibility = async (userId) => {
  if (!supabase) return { eligible: false, walletLinked: false, socialLinked: false };
  const [walletResult, socialResult] = await Promise.all([
    supabase.from('cl_wallets')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('watch_only', false),
    supabase.from('cl_linked_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('provider', ['google', 'discord']),
  ]);
  if (walletResult.error) throw walletResult.error;
  if (socialResult.error) throw socialResult.error;
  const walletLinked = (walletResult.count || 0) > 0;
  const socialLinked = (socialResult.count || 0) > 0;
  return { eligible: walletLinked && socialLinked, walletLinked, socialLinked };
};

const dbHydrateChatMessages = async (rows) => {
  const messages = Array.isArray(rows) ? rows : [];
  const ids = [...new Set(messages.map(row => row.user_id || row.sender_id).filter(Boolean))];
  let profiles = [];
  if (ids.length) {
    const result = await supabase.from('cl_users').select(CHAT_PROFILE_COLUMNS).in('id', ids);
    if (result.error) throw result.error;
    profiles = result.data || [];
  }
  const byId = new Map(profiles.map(profile => [profile.id, profile]));
  return messages.map(row => ({
    id: row.id,
    message_type: row.message_type,
    content: row.content,
    created_at: row.created_at,
    author: byId.get(row.user_id || row.sender_id) || {
      id: row.user_id || row.sender_id,
      display_name: 'ChainLens user',
      avatar_url: null,
    },
  }));
};

const dbFindFriendship = async (userId, otherUserId) => {
  const [userLow, userHigh] = orderedFriendPair(userId, otherUserId);
  const { data, error } = await supabase.from('cl_friendships')
    .select('*').eq('user_low', userLow).eq('user_high', userHigh).maybeSingle();
  if (error) throw error;
  return data;
};

const dbGetAcceptedFriendship = async (userId, otherUserId) => {
  const friendship = await dbFindFriendship(userId, otherUserId);
  return friendship?.status === 'accepted' ? friendship : null;
};

const parseChatCursor = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid message cursor');
  return cursor;
};

const parseChatMessageId = (value) => {
  const messageId = Number(value);
  if (!Number.isSafeInteger(messageId) || messageId < 1) throw new Error('Invalid message ID');
  return messageId;
};

// ─── Read cursors ────────────────────────────────────────────────────────────
// Unread state is server-side on purpose: the same account is signed in on the
// website, the desktop wallet, the extension and mobile, and reading a thread
// on one has to clear its badge on the rest.

const dmConversation = (friendshipId) => chatConversationKey(friendshipId);

const dbChatUnread = async (userId) => {
  // Back-dates a brand-new account's cursors so months of history do not land
  // as hundreds of unread on the first poll. No-ops after the first call — see
  // cl_chat_seed_reads in sql/cl_chat.sql.
  const seed = await supabase.rpc('cl_chat_seed_reads', { p_user_id: userId });
  if (seed.error) throw seed.error;

  const [unreadResult, pendingResult] = await Promise.all([
    // One grouped join for every thread — see cl_chat_unread in sql/cl_chat.sql.
    supabase.rpc('cl_chat_unread', { p_user_id: userId }),
    supabase.from('cl_friendships')
      .select('id', { count: 'exact', head: true })
      .or(`user_low.eq.${userId},user_high.eq.${userId}`)
      .eq('status', 'pending')
      .neq('requested_by', userId),
  ]);
  if (unreadResult.error) throw unreadResult.error;
  if (pendingResult.error) throw pendingResult.error;
  return summarizeChatUnread(unreadResult.data, pendingResult.count);
};

const chatMessageWindows = new Map();
const chatMessageAllowed = (userId) => {
  const now = Date.now();
  const recent = (chatMessageWindows.get(userId) || []).filter(time => now - time < 10_000);
  if (recent.length >= 6) {
    chatMessageWindows.set(userId, recent);
    return false;
  }
  recent.push(now);
  chatMessageWindows.set(userId, recent);
  return true;
};
const chatRateCleanup = setInterval(() => {
  const cutoff = Date.now() - 10_000;
  for (const [userId, times] of chatMessageWindows) {
    const recent = times.filter(time => time >= cutoff);
    if (recent.length) chatMessageWindows.set(userId, recent);
    else chatMessageWindows.delete(userId);
  }
}, 60_000);
chatRateCleanup.unref();

const chatDbFailure = (res, error, fallback = 'Chat is temporarily unavailable') => {
  console.error('ChainLens chat database error:', error);
  if (error?.code === '42P01') {
    return res.status(503).json({ error: 'Chat is not configured yet. Run sql/cl_chat.sql.' });
  }
  return res.status(500).json({ error: fallback });
};

const requireChatAccess = async (req, res, next) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  try {
    const access = await dbGetChatEligibility(req.user.sub);
    if (!access.eligible) {
      return res.status(403).json({
        error: 'Link at least one verified wallet and Google or Discord to use chat.',
        ...access,
      });
    }
    req.chatAccess = access;
    next();
  } catch (error) {
    chatDbFailure(res, error);
  }
};

const app = express();
const PORT = process.env.PORT || 10000;
const SEARCH_WORKER_BASE_URL = process.env.SEARCH_WORKER_BASE_URL || 'https://chainlens-search.guildfordking.workers.dev';
const searchRateLimits = new Map();

app.set('trust proxy', 1);
app.use(cors());
// Profile photos are stored in the shared avatar_url field as either HTTPS URLs
// or compact image data URLs. Keep the cap narrow enough to prevent oversized
// requests while allowing the 2 MB client-side avatar limit plus base64 overhead.
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const searchRateLimit = (req, res, next) => {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const limit = 30;
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const current = searchRateLimits.get(key);
  if (!current || now >= current.resetAt) {
    searchRateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return next();
  }
  if (current.count >= limit) {
    res.set('Retry-After', String(Math.ceil((current.resetAt - now) / 1000)));
    return res.status(429).json({ error: 'Too many searches. Please wait a moment and try again.' });
  }
  current.count += 1;
  next();
};

const searchRateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of searchRateLimits) {
    if (value.resetAt <= now) searchRateLimits.delete(key);
  }
}, 5 * 60 * 1000);
searchRateLimitCleanup.unref();

const API_KEYS = {
  alchemy: process.env.ALCHEMY_KEY,
  blockfrost: process.env.BLOCKFROST_KEY,
  helius: process.env.HELIUS_KEY,
  unstoppable: process.env.UNSTOPPABLE_KEY,
  dexhunter: process.env.DEXHUNTER_PARTNER_ID,
  jupiter: process.env.JUPITER_API_KEY,
  uniswap: process.env.UNISWAP_API_KEY,
  zerion: process.env.ZERION_KEY,
  moralis: process.env.MORALIS_KEY,
  coingecko: process.env.COINGECKO_KEY,
  coinmarketcap: process.env.COINMARKETCAP_API_KEY || process.env.CMC_API_KEY,
  subscan: process.env.SUBSCAN_API_KEY,
};

// Demo keys (CG- prefix) ONLY work on api.coingecko.com — pro keys use pro-api.coingecko.com.
// Sending a demo key to the pro endpoint (or vice versa) returns 401.
const _cgKey = process.env.COINGECKO_KEY;
const _cgIsDemo = _cgKey && _cgKey.startsWith('CG-');
const CG_BASE = (_cgKey && !_cgIsDemo) ? 'https://pro-api.coingecko.com' : 'https://api.coingecko.com';
const cgHeaders = () => {
  if (!_cgKey) return {};
  return _cgIsDemo ? { 'x-cg-demo-api-key': _cgKey } : { 'x-cg-pro-api-key': _cgKey };
};
console.log(_cgKey ? `✅ CoinGecko API key loaded (${_cgIsDemo ? 'demo' : 'pro'} tier)` : '⚠️  No COINGECKO_KEY — free tier only');

const CMC_BASE = 'https://pro-api.coinmarketcap.com';
const cmcHeaders = () => {
  if (!API_KEYS.coinmarketcap) return null;
  return { accept: 'application/json', 'X-CMC_PRO_API_KEY': API_KEYS.coinmarketcap };
};
const cmcUsdQuote = (coin) => {
  if (Array.isArray(coin?.quote)) {
    return coin.quote.find(q => q?.symbol === 'USD' || q?.id === 2781) || coin.quote[0] || {};
  }
  return coin?.quote?.USD || {};
};
const cmcLogoUrl = (id) => id ? `https://s2.coinmarketcap.com/static/img/coins/64x64/${id}.png` : '';
const mapCmcCoinForChainLens = (coin, idx = 0) => {
  const quote = cmcUsdQuote(coin);
  const price = Number(quote.price) || 0;
  return {
    id: coin.slug || (coin.symbol || '').toLowerCase(),
    symbol: (coin.symbol || '').toLowerCase(),
    name: coin.name || coin.symbol || 'Unknown',
    image: cmcLogoUrl(coin.id),
    current_price: price,
    market_cap: Number(quote.market_cap) || 0,
    market_cap_rank: coin.cmc_rank || idx + 1,
    fully_diluted_valuation: Number(quote.fully_diluted_market_cap) || 0,
    total_volume: Number(quote.volume_24h) || 0,
    high_24h: null,
    low_24h: null,
    price_change_24h: null,
    price_change_percentage_24h: Number(quote.percent_change_24h) || 0,
    market_cap_change_24h: null,
    market_cap_change_percentage_24h: null,
    circulating_supply: Number(coin.circulating_supply) || null,
    total_supply: Number(coin.total_supply) || null,
    max_supply: Number(coin.max_supply) || null,
    ath: null,
    ath_change_percentage: null,
    ath_date: null,
    atl: null,
    atl_change_percentage: null,
    atl_date: null,
    roi: null,
    last_updated: quote.last_updated || coin.last_updated || null,
    sparkline_in_7d: null,
    price_change_percentage_24h_in_currency: Number(quote.percent_change_24h) || 0,
    source: 'CoinMarketCap',
  };
};
const fetchCmcJson = async (path, params = {}, timeoutMs = 8000) => {
  const headers = cmcHeaders();
  if (!headers) throw new Error('COINMARKETCAP_API_KEY missing');
  const url = new URL(`${CMC_BASE}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`CoinMarketCap ${response.status}: ${json.status?.error_message || 'request failed'}`);
  return json;
};
const fetchCmcListings = async (limit = 100) => {
  const json = await fetchCmcJson('/v3/cryptocurrency/listings/latest', {
    start: 1,
    limit,
    convert: 'USD',
    sort: 'market_cap',
    sort_dir: 'desc',
  }, 10000);
  const rows = Array.isArray(json.data) ? json.data : [];
  if (rows.length === 0) throw new Error('CoinMarketCap empty listings');
  return rows.map(mapCmcCoinForChainLens);
};
const fetchCmcQuote = async (query) => {
  const normalized = String(query || '').trim();
  if (!normalized) throw new Error('CoinMarketCap empty query');
  const attempts = [];
  if (/^[a-z0-9$@]{1,15}$/i.test(normalized)) {
    attempts.push({ symbol: normalized.toUpperCase(), convert: 'USD', skip_invalid: true });
  }
  attempts.push({ slug: normalized.toLowerCase().replace(/\s+/g, '-'), convert: 'USD', skip_invalid: true });

  let lastErr = null;
  for (const params of attempts) {
    try {
      const json = await fetchCmcJson('/v3/cryptocurrency/quotes/latest', params, 8000);
      const rows = (Array.isArray(json.data) ? json.data : Object.values(json.data || {})).flat();
      const coin = rows.find(Boolean);
      if (coin) return mapCmcCoinForChainLens(coin);
      lastErr = new Error('CoinMarketCap no quote');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('CoinMarketCap no quote');
};
const fetchCmcChart = async (symbol, timeframeConfig) => {
  const intervalByDays = {
    1: '1h',
    7: '4h',
    30: '1d',
    365: '7d',
    max: '30d',
  };
  const countByDays = {
    1: 24,
    7: 42,
    30: 30,
    365: 53,
    max: 120,
  };
  const daysKey = String(timeframeConfig.days);
  const json = await fetchCmcJson('/v3/cryptocurrency/quotes/historical', {
    symbol: String(symbol || '').toUpperCase(),
    interval: intervalByDays[daysKey] || '4h',
    count: countByDays[daysKey] || 42,
    convert: 'USD',
    skip_invalid: true,
  }, 10000);
  const container = json.data && (json.data[String(symbol).toUpperCase()] || Object.values(json.data)[0]);
  const quotes = Array.isArray(container?.quotes) ? container.quotes : [];
  const formattedPrices = quotes
    .map(q => ({ time: Date.parse(q.timestamp), price: Number(q.quote?.USD?.price) }))
    .filter(p => Number.isFinite(p.time) && p.price > 0)
    .sort((a, b) => a.time - b.time);
  if (formattedPrices.length < 2) throw new Error('CoinMarketCap empty chart');
  return formattedPrices;
};
console.log(API_KEYS.coinmarketcap ? '✅ CoinMarketCap API key loaded' : '⚠️  No COINMARKETCAP_API_KEY — CMC fallback disabled');

// Binance endpoint rotation — if one host is throttled or down, the next is tried
const BINANCE_HOSTS = [
  'https://api.binance.com',
  'https://api-gcp.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com',
];
const fetchBinance = async (path, timeoutMs = 5000) => {
  for (const host of BINANCE_HOSTS) {
    try {
      const r = await fetch(`${host}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return r;
    } catch {}
  }
  return null;
};

const APP_HUB_CHAINS = [
  { id: 'ethereum', label: 'Ethereum' },
  { id: 'base', label: 'Base' },
  { id: 'polygon', label: 'Polygon' },
  { id: 'avalanche', label: 'Avalanche' },
  { id: 'optimism', label: 'Optimism' },
  { id: 'arbitrum', label: 'Arbitrum' },
  { id: 'abstract', label: 'Abstract' },
  { id: 'blast', label: 'Blast' },
  { id: 'zora', label: 'Zora' },
  { id: 'apechain', label: 'Ape Chain' },
  { id: 'soneium', label: 'Soneium' },
  { id: 'ronin', label: 'Ronin' },
  { id: 'worldchain', label: 'World Chain' },
  { id: 'gnosis', label: 'Gnosis' },
  { id: 'hyperevm', label: 'HyperEVM' },
  { id: 'monad', label: 'Monad' },
  { id: 'solana', label: 'Solana' },
  { id: 'cardano', label: 'Cardano' }
];

const APP_HUB_CATEGORY_META = {
  'Bridge / Interoperability': {
    short: 'Bridge',
    description: 'Move assets and messages across ecosystems.',
    accent: 'cyan'
  },
  'DEX / Bridge Aggregator': {
    short: 'DEX',
    description: 'Find routes, swaps, and cross-chain liquidity.',
    accent: 'emerald'
  },
  'Portfolio & Analytics': {
    short: 'Analytics',
    description: 'Track wallets, markets, positions, and onchain activity.',
    accent: 'blue'
  },
  'NFT Marketplace': {
    short: 'NFTs',
    description: 'Discover, buy, sell, and analyze NFT collections.',
    accent: 'amber'
  }
};

const APP_HUB_APPS = [
  { name: 'Wormhole', category: 'Bridge / Interoperability', website: 'https://wormhole.com', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'blast', 'gnosis', 'monad', 'solana', 'cardano'] },
  { name: 'LayerZero', category: 'Bridge / Interoperability', website: 'https://layerzero.network', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'abstract', 'blast', 'zora', 'apechain', 'soneium', 'ronin', 'worldchain', 'gnosis', 'monad', 'solana'] },
  { name: 'deBridge', category: 'Bridge / Interoperability', website: 'https://debridge.finance', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'blast', 'solana'] },
  { name: 'Across Protocol', category: 'Bridge / Interoperability', website: 'https://across.to', chains: ['ethereum', 'base', 'optimism', 'arbitrum', 'blast', 'zora'] },
  { name: 'Stargate Finance', category: 'Bridge / Interoperability', website: 'https://stargate.finance', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'blast'] },
  { name: 'Jumper Exchange', category: 'DEX / Bridge Aggregator', website: 'https://jumper.exchange', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'blast', 'gnosis', 'solana'] },
  { name: 'Pulsar Finance', category: 'Portfolio & Analytics', website: 'https://pulsar.finance', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'gnosis', 'solana', 'cardano'] },
  { name: 'CoinStats', category: 'Portfolio & Analytics', website: 'https://coinstats.app', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'gnosis', 'solana', 'cardano'] },
  { name: 'DeBank', category: 'Portfolio & Analytics', website: 'https://debank.com', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'blast', 'zora', 'ronin', 'worldchain', 'gnosis'] },
  { name: 'Zapper', category: 'Portfolio & Analytics', website: 'https://zapper.xyz', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'blast', 'zora', 'gnosis'] },
  { name: 'DefiLlama', category: 'Portfolio & Analytics', website: 'https://defillama.com', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'abstract', 'blast', 'zora', 'apechain', 'soneium', 'ronin', 'worldchain', 'gnosis', 'hyperevm', 'monad', 'solana', 'cardano'] },
  { name: 'DappRadar', category: 'Portfolio & Analytics', website: 'https://dappradar.com', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'blast', 'zora', 'ronin', 'gnosis', 'solana', 'cardano'] },
  { name: 'Magic Eden', category: 'NFT Marketplace', website: 'https://magiceden.io', chains: ['ethereum', 'base', 'polygon', 'arbitrum', 'solana'] },
  { name: 'OpenSea', category: 'NFT Marketplace', website: 'https://opensea.io', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'blast', 'zora', 'solana'] },
  { name: 'Element Market', category: 'NFT Marketplace', website: 'https://element.market', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'blast', 'zora', 'solana'] },
  { name: '1inch Network', category: 'DEX / Bridge Aggregator', website: 'https://1inch.io', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'blast', 'gnosis'] },
  { name: 'OpenOcean', category: 'DEX / Bridge Aggregator', website: 'https://openocean.finance', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'blast', 'gnosis', 'solana'] },
  { name: 'Odos', category: 'DEX / Bridge Aggregator', website: 'https://odos.xyz', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'blast', 'gnosis'] },
  { name: 'Matcha', category: 'DEX / Bridge Aggregator', website: 'https://matcha.xyz', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'blast'] },
  { name: 'Paraswap', category: 'DEX / Bridge Aggregator', website: 'https://paraswap.io', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum'] },
  { name: 'Celer Network', category: 'Bridge / Interoperability', website: 'https://celer.network', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'gnosis', 'solana'] },
  { name: 'Axelar', category: 'Bridge / Interoperability', website: 'https://axelar.network', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'blast', 'gnosis'] },
  { name: 'Orbiter Finance', category: 'Bridge / Interoperability', website: 'https://orbiter.finance', chains: ['ethereum', 'base', 'polygon', 'optimism', 'arbitrum', 'blast', 'zora'] },
  { name: 'Symbiosis Finance', category: 'Bridge / Interoperability', website: 'https://symbiosis.finance', chains: ['ethereum', 'base', 'polygon', 'avalanche', 'optimism', 'arbitrum', 'blast', 'zora', 'ronin'] },
  { name: 'Owlto Finance', category: 'Bridge / Interoperability', website: 'https://owlto.finance', chains: ['ethereum', 'base', 'polygon', 'optimism', 'arbitrum', 'blast', 'zora'] }
];

const normalizeAppHubApp = (appRecord) => ({
  ...appRecord,
  id: appRecord.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
  chainCount: appRecord.chains.length,
  coverage: Math.round((appRecord.chains.length / APP_HUB_CHAINS.length) * 100),
  categoryMeta: APP_HUB_CATEGORY_META[appRecord.category] || {}
});

const getAppHubPayload = () => {
  const apps = APP_HUB_APPS.map(normalizeAppHubApp);
  const categories = Object.entries(APP_HUB_CATEGORY_META).map(([name, meta]) => ({
    name,
    ...meta,
    count: apps.filter(appRecord => appRecord.category === name).length
  }));
  const chainStats = APP_HUB_CHAINS.map(chain => ({
    ...chain,
    count: apps.filter(appRecord => appRecord.chains.includes(chain.id)).length
  }));

  return {
    updatedAt: '2026-06-05',
    totalApps: apps.length,
    totalChains: APP_HUB_CHAINS.length,
    chains: APP_HUB_CHAINS,
    categories,
    chainStats,
    apps
  };
};

// --- Price Discovery Helper ---

// CoinGecko IDs for native tokens
const NATIVE_CG_IDS = {
  ETH: 'ethereum', MATIC: 'matic-network', POL: 'matic-network',
  AVAX: 'avalanche-2', RON: 'ronin', APE: 'apecoin',
  MON: 'monad', SOL: 'solana', ADA: 'cardano', BNB: 'binancecoin',
  XDAI: 'xdai', HYPE: 'hyperliquid', WLD: 'worldcoin-wld',
  BTC: 'bitcoin', DOT: 'polkadot', TRX: 'tron', DOGE: 'dogecoin'
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

// DefiLlama chain slugs (free coins API — no key needed)
// https://coins.llama.fi/prices/current/chain:address
const LLAMA_CHAIN = {
  ethereum:'ethereum', base:'base', polygon:'polygon', avalanche:'avax',
  optimism:'optimism', arbitrum:'arbitrum', blast:'blast', zora:'zora',
  abstract:'abstract', apechain:'apechain', soneium:'soneium', ronin:'ronin',
  worldchain:'worldchain', gnosis:'xdai', hyperevm:'hyperliquid', monad:'monad',
  solana:'solana', cardano:'cardano',
};

// Single DefiLlama token price lookup — used as fallback when DexScreener returns 0
const fetchLlamaPrice = async (chainId, address) => {
  const llamaChain = LLAMA_CHAIN[chainId];
  if (!llamaChain || !address) return 0;
  const key = `llama-${chainId}-${address}`;
  const hit = _cGet(key);
  if (hit !== null) return hit;
  try {
    const coin = `${llamaChain}:${address}`;
    const r = await fetch(`https://coins.llama.fi/prices/current/${encodeURIComponent(coin)}`);
    const d = await r.json();
    const price = d?.coins?.[coin]?.price || 0;
    if (price > 0) console.log(`🦙 DefiLlama price for ${coin}: $${price}`);
    return _cSet(key, price);
  } catch (e) { return _cSet(key, 0); }
};

// ERC20 price via DexScreener → DefiLlama fallback, with cache
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
    const dsPrice = pair ? parseFloat(pair.priceUsd) : 0;
    if (dsPrice > 0) return _cSet(key, dsPrice);
    // Fallback: DefiLlama Coins API
    const llamaPrice = await fetchLlamaPrice(chainId, address);
    return _cSet(key, llamaPrice);
  } catch (e) {
    // DexScreener failed — try Llama directly
    const llamaPrice = await fetchLlamaPrice(chainId, address);
    return _cSet(key, llamaPrice);
  }
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

// Fetch token logo by contract address — queries DexScreener, cached 24hr
const fetchTokenImageByAddress = async (dsChain, address) => {
  if (!dsChain || !address) return '';
  const key = `dex-${dsChain}-${address.toLowerCase()}`;
  if (_imageCache[key] !== undefined) return _imageCache[key];
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    if (!r.ok) { _imageCache[key] = ''; return ''; }
    const d = await r.json();
    // Prefer pair on the same chain, then any pair
    const img = d.pairs?.find(p => p.chainId === dsChain)?.info?.imageUrl
               || d.pairs?.[0]?.info?.imageUrl || '';
    _imageCache[key] = img;
    return img;
  } catch { _imageCache[key] = ''; return ''; }
};

// ══════════════════════════════════════════════════════════════════════════════
// AUTH & PROFILE ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// The exact string a wallet signs to prove address ownership. Shared by
// /wallet-login and /wallet-session so the two can never drift apart, and
// mirrored byte-for-byte in the MagicMoney wallet (src/main/chainlens-auth.ts —
// `loginMessage`). Any change here reads as "signature mismatch" on the client
// with nothing pointing at why, so it is not a string to edit casually.
const loginMessage = (address, nonce) => `ChainLens login\nAddress: ${address}\nNonce: ${nonce}`;

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

  const message = loginMessage(address, nonce);

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
      // ── Auto-derive AGW address if this is an EVM wallet ──────────────────
      if (chain === 'evm') {
        const agwAddress = await deriveAGWAddress(address);
        if (agwAddress && agwAddress !== address) {
          await dbLinkWallet(userId, { chain: 'evm', address: agwAddress.toLowerCase(), watch_only: true });
          console.log(`⚡ AGW watch-wallet auto-linked for user ${userId}`);
        }
      }
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
      // ── Auto-derive AGW address if this is an EVM wallet ──────────────────
      if (chain === 'evm') {
        const agwAddress = await deriveAGWAddress(address);
        if (agwAddress && agwAddress !== address) {
          await dbLinkWallet(user.id, { chain: 'evm', address: agwAddress.toLowerCase(), watch_only: true });
          console.log(`⚡ AGW watch-wallet auto-linked for new user ${user.id}`);
        }
      }
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

// ── Step 2b: Session for an EXPLICITLY NAMED account ─────────────────────────
//
// What MagicMoney Wallet signs in with, and deliberately NOT /wallet-login.
//
// /wallet-login with no Authorization header upserts ('evm_wallet', <address>)
// unconditionally. For anyone whose ChainLens account is keyed by something
// else — a Solana wallet, a Google login — with the same EVM address linked to
// it, that mints a SECOND account for one human. The wallet's own profile sync
// resolves the address to the original account (cloudflare-worker/db.js picks
// the oldest verified owner), so chat would have run as a parallel identity:
// a different ChainLens ID than the one the wallet shows people to add, and no
// social link, so permanently ineligible for chat it should have had.
//
// The fix is to stop guessing. The caller states which account it means, this
// verifies the signing address is a PROVED (non-watch-only) wallet of exactly
// that account, and the JWT names it. No creation, no linking, no merging, no
// "closest match" — a mismatch is an error the user resolves in Profile.
app.post('/api/auth/wallet-session', async (req, res) => {
  if (!ethersVerify) return res.status(503).json({ error: 'Signature verification unavailable' });
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  try {
    // The verdict itself lives in auth-session.js so it can be tested without a
    // server or a database — see test/auth-session.test.js.
    const verdict = await resolveWalletSession(req.body, {
      // Read AND consume in one step: a caller who gets past the nonce check has
      // spent it, so the same body replayed cannot reach the lookups.
      takeNonce: (addressKey) => {
        const stored = _authNonces[addressKey] || null;
        delete _authNonces[addressKey];
        return stored;
      },
      recoverAddress: (message, signature) => ethersVerify(message, signature),
      hasVerifiedWallet: async (userId, addressLower) => {
        const { data, error } = await supabase.from('cl_wallets')
          .select('id')
          .eq('user_id', userId).eq('chain', 'evm')
          .eq('address', addressLower).eq('watch_only', false)
          .maybeSingle();
        if (error) throw error;
        return !!data;
      },
      accountExists: async (userId) => {
        const { data } = await supabase.from('cl_users').select('id').eq('id', userId).maybeSingle();
        return !!data;
      },
    });
    if (!verdict.ok) {
      const { ok, status, ...payload } = verdict;   // eslint-disable-line no-unused-vars
      return res.status(status).json(payload);
    }

    const profile = await dbGetUserById(verdict.userId);
    if (!profile) return res.status(404).json({ error: 'No ChainLens account has that ID. Open Profile and connect first.' });
    // `sub` is the id the caller named and nothing else — that identity binding
    // is the entire purpose of this route.
    const token = jwt.sign({ sub: verdict.userId }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ token, profile });
  } catch (error) {
    console.error('ChainLens wallet-session error:', error);
    return res.status(500).json({ error: 'Could not start a ChainLens session' });
  }
});

// ── Watch-only wallet (no signature required) ────────────────────────────────
app.post('/api/auth/add-watch-wallet', requireAuth, async (req, res) => {
  const { chain, address } = req.body;
  if (!chain || typeof address !== 'string')
    return res.status(400).json({ error: 'chain and address required' });
  if (!PROFILE_WALLET_MAP[chain])
    return res.status(400).json({ error: 'Unsupported wallet type' });
  if (!validateProfileWalletAddress(chain, address))
    return res.status(400).json({ error: `Invalid ${PROFILE_WALLET_MAP[chain].label} address` });
  const normalizedAddress = normalizeProfileWalletAddress(chain, address);
  const userId = req.user.sub;
  try {
    if (supabase) {
      await dbLinkWallet(userId, { chain, address: normalizedAddress, watch_only: true });
    }
    const profile = await dbGetUserById(userId);
    res.json({ success: true, profile });
  } catch (e) {
    console.error('add-watch-wallet error:', e);
    res.status(500).json({ error: 'Failed to add watch wallet' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PASSKEY (WebAuthn) SIGN-IN
//
// A passkey is a keypair the device generates and keeps; only the public half
// reaches this server. Sign-in is a signature over a server-issued challenge —
// there is nothing to phish, replay, or steal from the database.
//
// Registration requires an existing session (Google/Discord/wallet), so a
// passkey is always ADDED to an account rather than creating one. That keeps a
// second way in: losing every passkey never locks you out of the account.
// ══════════════════════════════════════════════════════════════════════════════

const b64uEncode = (buf) => Buffer.from(buf).toString('base64url');
const b64uDecode = (str) => new Uint8Array(Buffer.from(str, 'base64url'));

const PASSKEY_TTL_MS = 5 * 60 * 1000;

// A ceremony id lets two tabs (or a retried prompt) each hold their own
// challenge instead of clobbering a single per-user slot.
const stashChallenge = (challenge, type, userId) => {
  const ceremony = crypto.randomBytes(16).toString('hex');
  _passkeyChallenges[ceremony] = { challenge, type, userId: userId || null, expires: Date.now() + PASSKEY_TTL_MS };
  return ceremony;
};

// Single-use: consumed on first read so a captured response cannot be replayed.
// `type` and `userId` pin a challenge to the exact ceremony it was issued for,
// so a registration challenge can never be redeemed as a sign-in or vice-versa.
const takeChallenge = (ceremony, type, userId) => {
  const entry = _passkeyChallenges[ceremony];
  if (!entry) return null;
  delete _passkeyChallenges[ceremony];
  if (entry.expires < Date.now()) return null;
  if (entry.type !== type) return null;
  if (entry.userId !== (userId || null)) return null;
  return entry.challenge;
};

// Best-effort friendly name so the list in Settings isn't a wall of
// indistinguishable rows. The user can send their own label instead.
const guessPasskeyLabel = (userAgent = '') => {
  const ua = String(userAgent);
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone / iPad';
  if (/Android/i.test(ua)) return 'Android device';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Passkey';
};

// ── Which authenticator minted this? ─────────────────────────────────────────
// The user agent says which BROWSER registered a passkey, not which
// authenticator holds it — so a Magic Money passkey and a Google Password
// Manager one both label as "Windows", and the list cannot tell the user which
// entry is which. The AAGUID is the field that names the issuer.
//
// ⚠ A HINT, NOT A PROOF. We accept attestationType 'none', so the AAGUID is
// self-asserted and nothing here is cryptographically bound to an issuer. It is
// good enough to label a row for a human and must never gate access.
const KNOWN_AAGUIDS = {
  '2c4b3c62-a6fc-6b9f-47f2-4ede41f1b4bf': 'Magic Money',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
};

const ZERO_AAGUID = '00000000-0000-0000-0000-000000000000';

// Magic Money credential ids are `0x01 || nonce(16) || tag(16)` — 33 bytes with
// a version byte. Unforgeable it is not; distinctive it is.
const looksLikeMagicMoneyCredential = (credentialId) => {
  try {
    const raw = Buffer.from(String(credentialId), 'base64url');
    return raw.length === 33 && raw[0] === 0x01;
  } catch { return false; }
};

const passkeyLabel = ({ aaguid, credentialId, userAgent }) => {
  const known = KNOWN_AAGUIDS[String(aaguid || '').toLowerCase()];
  if (known) return known;

  // ⚠ Magic Money's own in-app browser deliberately reports a ZEROED AAGUID:
  // blanking it is the client's job, and on that path the wallet is both the
  // authenticator and the client. So the passkeys most certainly ours are
  // exactly the ones the AAGUID cannot name. Fall back to the credential-id
  // shape, which is the only remaining signal that distinguishes them.
  if ((!aaguid || aaguid === ZERO_AAGUID) && looksLikeMagicMoneyCredential(credentialId)) {
    return 'Magic Money';
  }
  return guessPasskeyLabel(userAgent);
};

const passkeysConfigured = () => !!(webauthn && supabase);

// ── Can this deployment offer passkeys at all? (public) ──────────────────────
// The UI calls this before rendering any passkey button, so a server without
// the dep — or without sql/cl_passkeys.sql run — simply shows nothing rather
// than a button that errors when pressed.
app.get('/api/auth/passkey/available', async (req, res) => {
  if (!passkeysConfigured()) return res.json({ available: false, reason: 'not_configured' });
  try {
    const { error } = await supabase.from('cl_passkeys').select('id').limit(1);
    if (error) throw error;
    res.json({ available: true, rpId: RP_ID });
  } catch (e) {
    res.json({ available: false, reason: 'table_missing' });
  }
});

// ── Step 1 of registration: options + challenge (requires a session) ─────────
app.post('/api/auth/passkey/register-options', requireAuth, async (req, res) => {
  if (!passkeysConfigured()) return res.status(503).json({ error: 'Passkeys are not enabled on this server' });
  try {
    const user = await dbGetUserById(req.user.sub);
    if (!user) return res.status(404).json({ error: 'Account not found' });

    // Offering an authenticator a credential it already holds makes it refuse
    // rather than silently create a duplicate the user can't tell apart.
    const existing = await dbListPasskeys(user.id);

    const options = await webauthn.generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: new TextEncoder().encode(user.id),
      userName: user.email || user.display_name || `chainlens-${user.id.slice(0, 8)}`,
      userDisplayName: user.display_name || 'ChainLens',
      attestationType: 'none',            // no attestation: we don't track device models
      excludeCredentials: existing.map(p => ({
        id: p.credential_id,
        transports: p.transports || undefined,
      })),
      authenticatorSelection: {
        // Discoverable, so signing in needs no username typed at all.
        residentKey: 'required',
        // 'preferred', not 'required': a ChainLens profile is a read-only
        // portfolio view that holds no keys, so refusing PIN-less security keys
        // would cost compatibility for no real protection. Must stay paired
        // with requireUserVerification:false below.
        userVerification: 'preferred',
      },
    });

    res.json({ options, ceremony: stashChallenge(options.challenge, 'register', user.id) });
  } catch (e) {
    console.error('passkey register-options error:', e.message);
    res.status(503).json({ error: 'Passkeys are not set up on this server yet' });
  }
});

// ── Step 2 of registration: verify and store the public key ──────────────────
app.post('/api/auth/passkey/register', requireAuth, async (req, res) => {
  if (!passkeysConfigured()) return res.status(503).json({ error: 'Passkeys are not enabled on this server' });
  const { response, ceremony, label } = req.body || {};
  if (!response || !ceremony) return res.status(400).json({ error: 'response and ceremony required' });

  const expectedChallenge = takeChallenge(ceremony, 'register', req.user.sub);
  if (!expectedChallenge) return res.status(400).json({ error: 'That request expired — please try again' });

  try {
    const verification = await webauthn.verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: RP_ORIGINS,
      expectedRPID: RP_ID,
      requireUserVerification: false,
    });
    if (!verification.verified) return res.status(400).json({ error: 'Passkey could not be verified' });

    const { credential, credentialDeviceType, credentialBackedUp, aaguid } = verification.registrationInfo;
    await dbInsertPasskey(req.user.sub, {
      credential_id: credential.id,
      public_key: b64uEncode(credential.publicKey),
      counter: credential.counter || 0,
      transports: credential.transports || null,
      device_type: credentialDeviceType,
      backed_up: !!credentialBackedUp,
      // Name the authenticator, not the browser: with a seed-derived wallet a
      // user can hold several passkeys for this account and needs to tell them
      // apart in the list. A caller-supplied label still wins.
      label: (typeof label === 'string' && label.trim().slice(0, 60))
        || passkeyLabel({ aaguid, credentialId: credential.id, userAgent: req.headers['user-agent'] }),
    });

    res.json({ success: true, passkeys: await dbListPasskeys(req.user.sub) });
  } catch (e) {
    console.error('passkey register error:', e.message);
    // 23505 = unique violation: this credential is already registered somewhere.
    if (e.code === '23505') return res.status(409).json({ error: 'That passkey is already registered' });
    res.status(400).json({ error: 'Passkey registration failed' });
  }
});

// ── Step 1 of sign-in: challenge only (public) ───────────────────────────────
// No allowCredentials and no address in the request: the authenticator offers
// whichever discoverable ChainLens passkeys it holds. That also means this
// endpoint reveals nothing about who has an account.
app.post('/api/auth/passkey/login-options', async (req, res) => {
  if (!passkeysConfigured()) return res.status(503).json({ error: 'Passkeys are not enabled on this server' });
  try {
    const options = await webauthn.generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'preferred',
    });
    res.json({ options, ceremony: stashChallenge(options.challenge, 'login', null) });
  } catch (e) {
    console.error('passkey login-options error:', e.message);
    res.status(503).json({ error: 'Passkeys are not enabled on this server' });
  }
});

// ── Step 2 of sign-in: verify the assertion, issue a token ───────────────────
app.post('/api/auth/passkey/login', async (req, res) => {
  if (!passkeysConfigured()) return res.status(503).json({ error: 'Passkeys are not enabled on this server' });
  const { response, ceremony } = req.body || {};
  if (!response?.id || !ceremony) return res.status(400).json({ error: 'response and ceremony required' });

  const expectedChallenge = takeChallenge(ceremony, 'login', null);
  if (!expectedChallenge) return res.status(400).json({ error: 'That sign-in request expired — please try again' });

  try {
    const stored = await dbFindPasskey(response.id);
    // Deliberately the same message as a failed signature: a caller must not be
    // able to probe which credential ids this server knows about.
    if (!stored) return res.status(401).json({ error: 'Passkey not recognised' });

    const verification = await webauthn.verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: RP_ORIGINS,
      expectedRPID: RP_ID,
      requireUserVerification: false,
      credential: {
        id: stored.credential_id,
        publicKey: b64uDecode(stored.public_key),
        counter: Number(stored.counter) || 0,
        transports: stored.transports || undefined,
      },
    });
    if (!verification.verified) return res.status(401).json({ error: 'Passkey not recognised' });

    await dbTouchPasskey(stored.id, verification.authenticationInfo.newCounter);

    const profile = await dbGetUserById(stored.user_id);
    if (!profile) return res.status(401).json({ error: 'Passkey not recognised' });

    const token = jwt.sign({ sub: stored.user_id }, JWT_SECRET, { expiresIn: '30d' });
    console.log(`🔐 Passkey sign-in for user ${stored.user_id}`);
    res.json({ token, profile });
  } catch (e) {
    console.error('passkey login error:', e.message);
    res.status(401).json({ error: 'Passkey not recognised' });
  }
});

// ── List this account's passkeys ─────────────────────────────────────────────
// ⚠ An empty list here has meant three different things: the account really has
// no passkeys, the server has none configured, and the query threw. A client
// cannot safely prune its local passkey list against an answer that ambiguous —
// a transient database fault would read as "the user deleted everything". The
// `configured` / `unavailable` flags are additive (same shape, same status) and
// let a caller tell "none" from "don't know". See passkey-reconcile.ts in the
// wallet, which stays conservative when they are absent, for an older server.
app.get('/api/auth/passkey/list', requireAuth, async (req, res) => {
  if (!passkeysConfigured()) return res.json({ passkeys: [], configured: false });
  try { res.json({ passkeys: await dbListPasskeys(req.user.sub), configured: true }); }
  catch (e) {
    console.error('passkey list error:', e.message);
    res.json({ passkeys: [], configured: true, unavailable: true });
  }
});

// ── Remove one ───────────────────────────────────────────────────────────────
// The credential itself lives on the user's device; this only revokes its
// access here, so the UI tells them to delete it in their OS as well.
app.delete('/api/auth/passkey/:id', requireAuth, async (req, res) => {
  if (!passkeysConfigured()) return res.status(503).json({ error: 'Passkeys are not enabled on this server' });
  try {
    await dbDeletePasskey(req.user.sub, req.params.id);
    res.json({ success: true, passkeys: await dbListPasskeys(req.user.sub) });
  } catch (e) {
    console.error('passkey delete error:', e.message);
    res.status(500).json({ error: 'Failed to remove passkey' });
  }
});

// ── Google OAuth ──────────────────────────────────────────────────────────────
app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.redirect(`${FRONTEND_URL}/?auth_error=google_not_configured`);
  const state = crypto.randomBytes(16).toString('hex');
  // Store linkToken so callback knows whether this is a new login or linking to existing account
  _oauthStates[state] = {
    expires: Date.now() + 10 * 60 * 1000,
    linkToken: req.query.link_token || null
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
  // IMPORTANT: save state data BEFORE deleting it
  const stateData = _oauthStates[state];
  delete _oauthStates[state];
  const linkToken = stateData.linkToken || null;
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

    let user;
    if (supabase) {
      if (linkToken) {
        // LINK MODE: attach Google to an already-logged-in account
        try {
          const claims = jwt.verify(linkToken, JWT_SECRET);
          user = await dbGetUserById(claims.sub);
          if (!user) throw new Error('User not found');
          await dbLinkSocialAccount(user.id, {
            provider: 'google', provider_id: info.id,
            display_name: info.name, avatar_url: info.picture, email: info.email
          });
          // Update primary display info if not already set
          if (!user.avatar_url || !user.email) {
            await supabase.from('cl_users').update({
              avatar_url: user.avatar_url || info.picture,
              email: user.email || info.email
            }).eq('id', user.id);
          }
          const jwtToken = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '30d' });
          return res.redirect(`${FRONTEND_URL}/?auth_token=${jwtToken}&linked=google`);
        } catch (e) {
          console.error('Google link error:', e);
          return res.redirect(`${FRONTEND_URL}/?auth_error=link_failed`);
        }
      } else {
        // LOGIN MODE: find existing account or create new one
        const existing = await dbFindUserBySocial('google', info.id);
        if (existing) {
          user = existing;
          // Refresh social record with latest info
          await dbLinkSocialAccount(user.id, {
            provider: 'google', provider_id: info.id,
            display_name: info.name, avatar_url: info.picture, email: info.email
          });
        } else {
          user = await dbUpsertUser({
            provider: 'google', provider_id: info.id,
            display_name: info.name, avatar_url: info.picture, email: info.email
          });
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
  // Store linkToken so callback knows whether this is a new login or linking to existing account
  _oauthStates[state] = {
    expires: Date.now() + 10 * 60 * 1000,
    linkToken: req.query.link_token || null
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
  // IMPORTANT: save state data BEFORE deleting it
  const stateData = _oauthStates[state];
  delete _oauthStates[state];
  const linkToken = stateData.linkToken || null;
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
    const discordName = info.global_name || info.username;

    let user;
    if (supabase) {
      if (linkToken) {
        // LINK MODE: attach Discord to an already-logged-in account
        try {
          const claims = jwt.verify(linkToken, JWT_SECRET);
          user = await dbGetUserById(claims.sub);
          if (!user) throw new Error('User not found');
          await dbLinkSocialAccount(user.id, {
            provider: 'discord', provider_id: info.id,
            display_name: discordName, avatar_url: avatar, email: info.email
          });
          // Update primary avatar if not already set
          if (!user.avatar_url) {
            await supabase.from('cl_users').update({ avatar_url: avatar }).eq('id', user.id);
          }
          const jwtToken = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '30d' });
          return res.redirect(`${FRONTEND_URL}/?auth_token=${jwtToken}&linked=discord`);
        } catch (e) {
          console.error('Discord link error:', e);
          return res.redirect(`${FRONTEND_URL}/?auth_error=link_failed`);
        }
      } else {
        // LOGIN MODE: find existing account or create new one
        const existing = await dbFindUserBySocial('discord', info.id);
        if (existing) {
          user = existing;
          // Refresh social record with latest info
          await dbLinkSocialAccount(user.id, {
            provider: 'discord', provider_id: info.id,
            display_name: discordName, avatar_url: avatar, email: info.email
          });
        } else {
          user = await dbUpsertUser({
            provider: 'discord', provider_id: info.id,
            display_name: discordName, avatar_url: avatar, email: info.email
          });
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
  const updates = {};

  if (req.body.display_name !== undefined) {
    if (typeof req.body.display_name !== 'string') {
      return res.status(400).json({ error: 'Display name must be text' });
    }
    const displayName = req.body.display_name.trim();
    if (!displayName || displayName.length > 32) {
      return res.status(400).json({ error: 'Display name must be 1–32 characters' });
    }
    updates.display_name = displayName;
  }

  if (req.body.avatar_url !== undefined) {
    if (typeof req.body.avatar_url !== 'string') {
      return res.status(400).json({ error: 'Profile picture must be an image URL' });
    }
    const avatarUrl = req.body.avatar_url.trim();
    const isRemoteImage = /^https:\/\//i.test(avatarUrl);
    const isImageData = /^data:image\/(?:jpeg|png|gif|webp);base64,/i.test(avatarUrl);
    if (avatarUrl && !isRemoteImage && !isImageData) {
      return res.status(400).json({ error: 'Profile picture must use HTTPS or a supported image file' });
    }
    if (avatarUrl.length > 2.8 * 1024 * 1024) {
      return res.status(413).json({ error: 'Profile picture is too large' });
    }
    updates.avatar_url = avatarUrl || null;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No profile changes supplied' });
  }

  const { data, error } = await supabase
    .from('cl_users').update(updates).eq('id', req.user.sub).select().single();
  if (error) return res.status(500).json({ error: 'Failed to update profile' });
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

// ── Hidden/spam asset list (cl_asset_filters) ────────────────────────────────
//
// The same list MagicMoney Wallet writes through its Cloudflare Worker, under
// the same keys (public/asset-filter-key.js). Hide a scam airdrop in the wallet
// and it is already hidden here; hide it here and it is hidden on every device
// the wallet is signed in on.
//
// Both routes fail SOFT. The list is a convenience, and a 500 here must never
// stop the portfolio rendering — the client keeps its localStorage copy, which
// is what it renders from anyway.

const FILTER_STATES = new Set(['h', 's', 'a']);
const MAX_FILTER_ENTRIES = 2000;

const sanitizeFilterEntries = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, e] of Object.entries(value)) {
    if (!key || key.length > 256) continue;
    if (!e || typeof e !== 'object') continue;
    if (!FILTER_STATES.has(e.s)) continue;
    if (typeof e.t !== 'number' || !Number.isFinite(e.t)) continue;
    out[key] = { s: e.s, t: e.t };
  }
  return out;
};

// Per-key last-write-wins union — ported from src/shared/asset-filter-key.ts in
// the wallet repo, and byte-for-byte the merge the Worker runs. Clients push
// their WHOLE list, so overwriting would let one device undo another's hide;
// merging on the newer timestamp is also what lets a restore ('a') out-rank a
// stale hide instead of being re-added by it.
const mergeFilterEntries = (base, incoming) => {
  const out = {};
  for (const src of [sanitizeFilterEntries(base), sanitizeFilterEntries(incoming)]) {
    for (const [key, e] of Object.entries(src)) {
      if (!out[key] || e.t > out[key].t) out[key] = e;
    }
  }
  const keys = Object.keys(out);
  if (keys.length <= MAX_FILTER_ENTRIES) return out;
  const kept = {};
  for (const key of keys.sort((a, b) => out[b].t - out[a].t).slice(0, MAX_FILTER_ENTRIES)) {
    kept[key] = out[key];
  }
  return kept;
};

// A missing table (operator hasn't run sql/cl_asset_filters.sql) reads as
// "nothing hidden" rather than a 500, so deploying ahead of the SQL is safe.
const dbReadFilters = async (userId) => {
  if (!supabase) return {};
  const { data } = await supabase
    .from('cl_asset_filters').select('entries').eq('user_id', userId).maybeSingle();
  return sanitizeFilterEntries(data?.entries);
};

app.get('/api/profile/filters', requireAuth, async (req, res) => {
  if (!supabase) return res.json({ entries: {} });
  try {
    res.json({ entries: await dbReadFilters(req.user.sub) });
  } catch {
    res.json({ entries: {} });
  }
});

app.put('/api/profile/filters', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  const incoming = sanitizeFilterEntries(req.body?.entries);
  try {
    // Read-merge-write. Two devices pushing in the same instant can still lose
    // one side's newest decision; the user hides it again, which is not worth a
    // transaction on a preferences list.
    const merged = mergeFilterEntries(await dbReadFilters(req.user.sub), incoming);
    const { error } = await supabase.from('cl_asset_filters')
      .upsert({ user_id: req.user.sub, entries: merged, updated_at: new Date().toISOString() },
              { onConflict: 'user_id' });
    if (error) return res.status(500).json({ error: 'Failed to save hidden assets' });
    res.json({ entries: merged });
  } catch {
    res.status(500).json({ error: 'Failed to save hidden assets' });
  }
});

// ── Custom themes (cl_themes) ────────────────────────────────────────────────
//
// The themes the user built in MagicMoney Wallet, which the wallet pushes to
// this account through its Cloudflare Worker (src/main/theme-sync.ts). ChainLens
// only READS them: a theme is made and edited in the wallet, and wearing one
// here is a per-install choice that never travels back.
//
// Gated on exactly what chat is gated on — a verified wallet AND a Google or
// Discord account — because that is the rule the product states for everything
// beyond Light and Dark. Failing that gate is a 200 with eligible:false, not a
// 403: the client draws the picker from this one call, so "you may not" and
// "here they are" are two shapes of the same answer, and only a real fault is
// an error.
//
// ⚠ The parser below is a hand-kept port of sanitizeThemeEntries in the wallet's
// src/shared/theme-sync-wire.ts, which public/theme-engine.js also carries.
// Drift is SILENT: a theme this rejects is simply a theme that never shows up.

const THEME_ID_MAX = 64;
const THEME_NAME_MAX = 24;
const MAX_THEME_ENTRIES = 64;
const THEME_HEX_RE = /^#[0-9a-f]{6}$/i;

const cleanThemeHex = (value) => {
  if (typeof value !== 'string') return null;
  const hex = value.trim();
  return THEME_HEX_RE.test(hex) ? hex.toLowerCase() : null;
};

const sanitizeThemeEntries = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  let seen = 0;
  for (const [id, raw] of Object.entries(value)) {
    if (seen >= MAX_THEME_ENTRIES) break;
    if (!id || id.length > THEME_ID_MAX || !id.startsWith('custom-')) continue;
    if (!raw || typeof raw !== 'object') continue;
    // typeof first: Number(null) is 0, which is finite and non-negative, so a
    // null timestamp would sail through as "the oldest possible entry".
    const t = raw.t;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) continue;

    // 'd' is a TOMBSTONE, not an absence — it is what keeps a theme deleted on
    // one device from being resurrected by another device's next push. Passed
    // through so the client can tell "deleted" from "never seen".
    if (raw.d === 1) {
      out[id] = { n: '', c: { bg: '', accent: '', text: '' }, t, d: 1 };
      seen++;
      continue;
    }

    const bg = cleanThemeHex(raw.c?.bg);
    const accent = cleanThemeHex(raw.c?.accent);
    const text = cleanThemeHex(raw.c?.text);
    if (!bg || !accent || !text) continue;
    out[id] = {
      n: (typeof raw.n === 'string' ? raw.n : '').trim().slice(0, THEME_NAME_MAX) || 'Custom',
      c: { bg, accent, text },
      t,
    };
    seen++;
  }
  return out;
};

app.get('/api/profile/themes', requireAuth, async (req, res) => {
  const denied = { eligible: false, walletLinked: false, socialLinked: false, entries: {} };
  if (!supabase) return res.json(denied);
  try {
    const access = await dbGetChatEligibility(req.user.sub);
    if (!access.eligible) return res.json({ ...access, entries: {} });

    // A missing table (operator has not run sql/cl_themes.sql) reads as "no
    // custom themes" rather than a 500 — the twelve built-ins are client-side
    // and must keep working on their own.
    const { data } = await supabase
      .from('cl_themes').select('entries').eq('user_id', req.user.sub).maybeSingle();
    res.json({ ...access, entries: sanitizeThemeEntries(data?.entries) });
  } catch (error) {
    // Only the eligibility lookup throws — the themes read above reports a
    // failure as no row. So this is "cannot tell whether you qualify", and it
    // answers no, the same way requireChatAccess refuses a chat it cannot check.
    console.error('ChainLens theme eligibility check failed:', error);
    res.json(denied);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CHAINLENS MESSENGER
//
// Eligibility is checked on every route: a verified (non-watch-only) wallet and
// at least one Google/Discord account are both required. IDs shown on the
// profile are the exact UUIDs used to send friend requests.
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/chat/status', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  try {
    const access = await dbGetChatEligibility(req.user.sub);
    res.json({
      ...access,
      giphyApiKey: access.eligible ? (process.env.GIPHY_API_KEY || null) : null,
    });
  } catch (error) {
    chatDbFailure(res, error);
  }
});

app.get('/api/chat/world', requireAuth, requireChatAccess, async (req, res) => {
  try {
    const after = parseChatCursor(req.query.after);
    let query = supabase.from('cl_world_messages')
      .select('id, user_id, message_type, content, created_at');
    if (after !== null) {
      query = query.gt('id', after).order('id', { ascending: true }).limit(CHAT_POLL_PAGE);
    } else {
      query = query.order('id', { ascending: false }).limit(CHAT_INITIAL_PAGE);
    }
    const { data, error } = await query;
    if (error) return chatDbFailure(res, error);
    const rows = after === null ? [...(data || [])].reverse() : (data || []);
    res.json({ messages: await dbHydrateChatMessages(rows) });
  } catch (error) {
    if (error.message === 'Invalid message cursor') return res.status(400).json({ error: error.message });
    chatDbFailure(res, error);
  }
});

app.post('/api/chat/world', requireAuth, requireChatAccess, async (req, res) => {
  if (!chatMessageAllowed(req.user.sub)) {
    return res.status(429).json({ error: 'You are sending messages too quickly. Try again in a moment.' });
  }
  let message;
  try {
    message = normalizeChatContent(req.body?.type, req.body?.content, { allowLinks: false });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const { data, error } = await supabase.from('cl_world_messages')
      .insert({ user_id: req.user.sub, ...message })
      .select('id, user_id, message_type, content, created_at').single();
    if (error) return chatDbFailure(res, error, 'Could not send that message');
    const [hydrated] = await dbHydrateChatMessages([data]);
    res.status(201).json({ message: hydrated });
  } catch (error) {
    chatDbFailure(res, error, 'Could not send that message');
  }
});

// The service-role database client bypasses RLS, so ownership is deliberately
// part of the DELETE filter. A guessed message id can never delete another
// user's World Chat message.
app.delete('/api/chat/world/:messageId', requireAuth, requireChatAccess, async (req, res) => {
  let messageId;
  try {
    messageId = parseChatMessageId(req.params.messageId);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const { data, error } = await supabase.from('cl_world_messages')
      .delete()
      .eq('id', messageId)
      .eq('user_id', req.user.sub)
      .select('id')
      .maybeSingle();
    if (error) return chatDbFailure(res, error, 'Could not delete that message');
    if (!data) return res.status(404).json({ error: 'Message not found or already deleted' });
    res.json({ success: true, message_id: data.id });
  } catch (error) {
    chatDbFailure(res, error, 'Could not delete that message');
  }
});

const dbListChatFriends = async (userId) => {
  const { data, error } = await supabase.from('cl_friendships')
    .select('*')
    .or(`user_low.eq.${userId},user_high.eq.${userId}`)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  const rows = data || [];
  const otherIds = [...new Set(rows.map(row => row.user_low === userId ? row.user_high : row.user_low))];
  let profiles = [];
  if (otherIds.length) {
    const result = await supabase.from('cl_users').select(CHAT_PROFILE_COLUMNS).in('id', otherIds);
    if (result.error) throw result.error;
    profiles = result.data || [];
  }
  const byId = new Map(profiles.map(profile => [profile.id, profile]));
  const summary = { friends: [], incoming: [], outgoing: [] };
  for (const row of rows) {
    const otherId = row.user_low === userId ? row.user_high : row.user_low;
    const profile = byId.get(otherId);
    if (!profile) continue;
    const item = {
      friendship_id: row.id,
      ...profile,
      created_at: row.created_at,
      accepted_at: row.accepted_at,
    };
    if (row.status === 'accepted') summary.friends.push(item);
    else if (row.requested_by === userId) summary.outgoing.push(item);
    else summary.incoming.push(item);
  }
  return summary;
};

app.get('/api/chat/friends', requireAuth, requireChatAccess, async (req, res) => {
  try {
    res.json(await dbListChatFriends(req.user.sub));
  } catch (error) {
    chatDbFailure(res, error, 'Could not load friends');
  }
});

app.post('/api/chat/friends', requireAuth, requireChatAccess, async (req, res) => {
  const chainlensId = typeof req.body?.chainlens_id === 'string'
    ? req.body.chainlens_id.trim().toLowerCase()
    : '';
  if (!isUuid(chainlensId)) return res.status(400).json({ error: 'Enter a valid ChainLens ID' });
  let pair;
  try {
    pair = orderedFriendPair(req.user.sub, chainlensId);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const { data: target, error: targetError } = await supabase.from('cl_users')
      .select(CHAT_PROFILE_COLUMNS).eq('id', chainlensId).maybeSingle();
    if (targetError) return chatDbFailure(res, targetError, 'Could not look up that ChainLens ID');
    if (!target) return res.status(404).json({ error: 'No ChainLens account has that ID' });
    const targetAccess = await dbGetChatEligibility(chainlensId);
    if (!targetAccess.eligible) {
      return res.status(409).json({ error: 'That account has not unlocked ChainLens chat yet' });
    }

    const existing = await dbFindFriendship(req.user.sub, chainlensId);
    if (existing?.status === 'accepted') return res.status(409).json({ error: 'You are already friends' });
    if (existing?.requested_by === req.user.sub) return res.status(409).json({ error: 'Friend request already sent' });
    if (existing) return res.status(409).json({ error: 'This person already sent you a friend request' });

    const now = new Date().toISOString();
    const { data, error } = await supabase.from('cl_friendships').insert({
      user_low: pair[0],
      user_high: pair[1],
      requested_by: req.user.sub,
      status: 'pending',
      updated_at: now,
    }).select('id, created_at').single();
    if (error?.code === '23505') return res.status(409).json({ error: 'A friend request already exists' });
    if (error) return chatDbFailure(res, error, 'Could not send friend request');
    res.status(201).json({
      request: { friendship_id: data.id, ...target, created_at: data.created_at },
    });
  } catch (error) {
    chatDbFailure(res, error, 'Could not send friend request');
  }
});

app.post('/api/chat/friends/:friendshipId/accept', requireAuth, requireChatAccess, async (req, res) => {
  const friendshipId = Number(req.params.friendshipId);
  if (!Number.isSafeInteger(friendshipId) || friendshipId < 1) {
    return res.status(400).json({ error: 'Invalid friend request' });
  }
  try {
    const { data: friendship, error } = await supabase.from('cl_friendships')
      .select('*').eq('id', friendshipId).maybeSingle();
    if (error) return chatDbFailure(res, error, 'Could not accept friend request');
    if (!friendship || (friendship.user_low !== req.user.sub && friendship.user_high !== req.user.sub)) {
      return res.status(404).json({ error: 'Friend request not found' });
    }
    if (friendship.status !== 'pending') return res.status(409).json({ error: 'Friend request is no longer pending' });
    if (friendship.requested_by === req.user.sub) {
      return res.status(403).json({ error: 'The recipient must accept this request' });
    }
    const now = new Date().toISOString();
    const result = await supabase.from('cl_friendships')
      .update({ status: 'accepted', accepted_at: now, updated_at: now })
      .eq('id', friendshipId).eq('status', 'pending');
    if (result.error) return chatDbFailure(res, result.error, 'Could not accept friend request');
    res.json({ success: true });
  } catch (error) {
    chatDbFailure(res, error, 'Could not accept friend request');
  }
});

// Decline/cancel a pending request or remove an accepted friend. The participant
// check keeps another user's numeric friendship id from becoming an IDOR.
app.delete('/api/chat/friends/:friendshipId', requireAuth, requireChatAccess, async (req, res) => {
  const friendshipId = Number(req.params.friendshipId);
  if (!Number.isSafeInteger(friendshipId) || friendshipId < 1) {
    return res.status(400).json({ error: 'Invalid friendship' });
  }
  try {
    const { data: friendship, error } = await supabase.from('cl_friendships')
      .select('id, user_low, user_high').eq('id', friendshipId).maybeSingle();
    if (error) return chatDbFailure(res, error, 'Could not update friends');
    if (!friendship || (friendship.user_low !== req.user.sub && friendship.user_high !== req.user.sub)) {
      return res.status(404).json({ error: 'Friendship not found' });
    }
    const result = await supabase.from('cl_friendships').delete().eq('id', friendshipId);
    if (result.error) return chatDbFailure(res, result.error, 'Could not update friends');
    res.json({ success: true });
  } catch (error) {
    chatDbFailure(res, error, 'Could not update friends');
  }
});

app.get('/api/chat/friends/:friendId/messages', requireAuth, requireChatAccess, async (req, res) => {
  const friendId = String(req.params.friendId || '').toLowerCase();
  if (!isUuid(friendId)) return res.status(400).json({ error: 'Invalid friend ID' });
  try {
    const friendship = await dbGetAcceptedFriendship(req.user.sub, friendId);
    if (!friendship) return res.status(403).json({ error: 'Direct messages are only available between friends' });
    const after = parseChatCursor(req.query.after);
    let query = supabase.from('cl_direct_messages')
      .select('id, sender_id, message_type, content, created_at')
      .eq('friendship_id', friendship.id);
    if (after !== null) {
      query = query.gt('id', after).order('id', { ascending: true }).limit(CHAT_POLL_PAGE);
    } else {
      query = query.order('id', { ascending: false }).limit(CHAT_INITIAL_PAGE);
    }
    const { data, error } = await query;
    if (error) return chatDbFailure(res, error, 'Could not load direct messages');
    const rows = after === null ? [...(data || [])].reverse() : (data || []);
    res.json({ messages: await dbHydrateChatMessages(rows) });
  } catch (error) {
    if (error.message === 'Invalid message cursor') return res.status(400).json({ error: error.message });
    chatDbFailure(res, error, 'Could not load direct messages');
  }
});

app.post('/api/chat/friends/:friendId/messages', requireAuth, requireChatAccess, async (req, res) => {
  const friendId = String(req.params.friendId || '').toLowerCase();
  if (!isUuid(friendId)) return res.status(400).json({ error: 'Invalid friend ID' });
  if (!chatMessageAllowed(req.user.sub)) {
    return res.status(429).json({ error: 'You are sending messages too quickly. Try again in a moment.' });
  }
  let message;
  try {
    message = normalizeChatContent(req.body?.type, req.body?.content, { allowLinks: true });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const friendship = await dbGetAcceptedFriendship(req.user.sub, friendId);
    if (!friendship) return res.status(403).json({ error: 'Direct messages are only available between friends' });
    const { data, error } = await supabase.from('cl_direct_messages').insert({
      friendship_id: friendship.id,
      sender_id: req.user.sub,
      ...message,
    }).select('id, sender_id, message_type, content, created_at').single();
    if (error) return chatDbFailure(res, error, 'Could not send that direct message');
    const [hydrated] = await dbHydrateChatMessages([data]);
    res.status(201).json({ message: hydrated });
  } catch (error) {
    chatDbFailure(res, error, 'Could not send that direct message');
  }
});

app.delete('/api/chat/friends/:friendId/messages/:messageId', requireAuth, requireChatAccess, async (req, res) => {
  const friendId = String(req.params.friendId || '').toLowerCase();
  if (!isUuid(friendId)) return res.status(400).json({ error: 'Invalid friend ID' });
  let messageId;
  try {
    messageId = parseChatMessageId(req.params.messageId);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const friendship = await dbGetAcceptedFriendship(req.user.sub, friendId);
    if (!friendship) return res.status(403).json({ error: 'Direct messages are only available between friends' });
    const { data, error } = await supabase.from('cl_direct_messages')
      .delete()
      .eq('id', messageId)
      .eq('friendship_id', friendship.id)
      .eq('sender_id', req.user.sub)
      .select('id')
      .maybeSingle();
    if (error) return chatDbFailure(res, error, 'Could not delete that direct message');
    if (!data) return res.status(404).json({ error: 'Message not found or already deleted' });
    res.json({ success: true, message_id: data.id });
  } catch (error) {
    chatDbFailure(res, error, 'Could not delete that direct message');
  }
});

// ── Unread badge ─────────────────────────────────────────────────────────────
//
// The ONE aggregate a signed-in client polls in the background. World Chat is
// deliberately absent: it is busy enough that a badge tied to it would never
// clear, so its unseen-message state stays inside the Messenger as the
// "Scroll to bottom" affordance and nothing else.
app.get('/api/chat/unread', requireAuth, requireChatAccess, async (req, res) => {
  try {
    res.json(await dbChatUnread(req.user.sub));
  } catch (error) {
    chatDbFailure(res, error, 'Could not load unread counts');
  }
});

// Mark a conversation read up to a message id. Callers send the newest id they
// have actually displayed; the cursor only ever moves forward (the GREATEST in
// cl_chat_mark_read), so a stale request overtaking a newer one is harmless.
app.post('/api/chat/read', requireAuth, requireChatAccess, async (req, res) => {
  const friendId = typeof req.body?.friend_id === 'string' ? req.body.friend_id.trim().toLowerCase() : '';
  let lastReadId;
  try {
    lastReadId = parseChatCursor(req.body?.last_read_id);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  if (lastReadId === null) return res.status(400).json({ error: 'last_read_id required' });

  try {
    let conversation = WORLD_CONVERSATION;
    if (friendId) {
      if (!isUuid(friendId)) return res.status(400).json({ error: 'Invalid friend ID' });
      // The cursor names a friendship id, so it has to be one this user is
      // actually in — otherwise any authenticated account could write cursors
      // into other people's conversations.
      const friendship = await dbGetAcceptedFriendship(req.user.sub, friendId);
      if (!friendship) return res.status(403).json({ error: 'Direct messages are only available between friends' });
      conversation = dmConversation(friendship.id);
    }
    const { data, error } = await supabase.rpc('cl_chat_mark_read', {
      p_user_id: req.user.sub,
      p_conversation: conversation,
      p_last_read_id: lastReadId,
    });
    if (error) return chatDbFailure(res, error, 'Could not update read state');
    res.json({ conversation, last_read_id: Number(data) || 0 });
  } catch (error) {
    chatDbFailure(res, error, 'Could not update read state');
  }
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

// --- APP HUB CATALOG ---

app.get('/api/app-hub', (req, res) => {
  res.json(getAppHubPayload());
});

// --- SEARCH (compatibility proxy to the Cloudflare search Worker) ---

app.get('/api/search/status', (req, res) => {
  res.json({ provider: 'searxng-cloudflare-worker', configured: true });
});

app.post('/api/search/activity', searchRateLimit, async (req, res) => {
  try {
    const requestUrl = new URL('/api/search/activity', SEARCH_WORKER_BASE_URL);
    const response = await fetch(requestUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(70000),
      headers: { Accept: 'application/json', Origin: 'https://chainlensnft.info' },
    });
    if (!response.ok) throw new Error(`Search warm-up returned HTTP ${response.status}.`);
    await response.body?.cancel();
    res.status(204).end();
  } catch (error) {
    console.warn('⚠️  Search activity warm-up failed:', error.message);
    res.status(503).json({ error: 'Search warm-up is temporarily unavailable.' });
  }
});

app.get('/api/search/web', searchRateLimit, async (req, res) => {
  try {
    const requestUrl = new URL('/api/search/web', SEARCH_WORKER_BASE_URL);
    requestUrl.searchParams.set('q', String(req.query.q || ''));
    const response = await fetch(requestUrl, {
      signal: AbortSignal.timeout(70000),
      headers: { Accept: 'application/json', Origin: 'https://chainlensnft.info' },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || 'Web search is temporarily unavailable.');
      error.statusCode = response.status;
      throw error;
    }
    res.set('Cache-Control', 'private, max-age=60');
    res.json(payload);
  } catch (error) {
    const status = error.statusCode || 503;
    if (status >= 500) console.warn('⚠️  Web search failed:', error.message);
    res.status(status).json({ error: error.message || 'Web search is temporarily unavailable.' });
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
      hyperevm:   { symbol:'HYPE', name:'HyperEVM',   logo:'https://assets.coingecko.com/coins/images/53805/small/Hyperliquid.png' },
      worldchain: { symbol:'WLD',  name:'Worldcoin',  logo:'https://cryptologos.cc/logos/worldcoin-org-wld-logo.png' },
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
          image: await (async () => {
            if (metadata.logo) return metadata.logo;
            // TrustWallet assets — use chain-specific path and verify it exists (HEAD request)
            const twChain = { ethereum:'ethereum', base:'base', polygon:'polygon',
              avalanche:'avalanche', optimism:'optimism', arbitrum:'arbitrum',
              gnosis:'xdai', ronin:'ronin', apechain:'apechain' }[chainId] || null;
            if (twChain) {
              const twUrl = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${twChain}/assets/${token.contractAddress}/logo.png`;
              try {
                const twRes = await fetch(twUrl, { method: 'HEAD' });
                if (twRes.ok) return twUrl;
              } catch {}
            }
            // DexScreener by contract address (covers Abstract, Monad, Blast, Zora, etc.)
            const dsChainId = { ethereum:'ethereum', base:'base', polygon:'polygon',
              avalanche:'avalanche', optimism:'optimism', arbitrum:'arbitrum',
              abstract:'abstract', blast:'blast', zora:'zora', apechain:'ape',
              soneium:'soneium', gnosis:'xdai', ronin:'ronin', worldchain:'worldchain',
              hyperevm:'hyperliquid' }[chainId];
            if (dsChainId) {
              const dexImg = await fetchTokenImageByAddress(dsChainId, token.contractAddress);
              if (dexImg) return dexImg;
            }
            // CoinGecko symbol search as final fallback
            return await fetchTokenImage(metadata.symbol);
          })(),
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
const evmChains = SCANNER_EVM_CHAINS
  .filter(chain => chain.alchemyNetwork)
  .map(chain => ({ id: chain.id, net: chain.alchemyNetwork }));

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

// --- Bitcoin / Polkadot / Tron / Dogecoin ---
// These are address scanners only: native balances and recent native transfers.
// NFTs are intentionally empty because these chains do not share an NFT indexer
// contract with ChainLens's EVM/Solana/Cardano adapters.
const nonEvmScanner = createNonEvmScanner({
  fetchImpl: fetch,
  getNativePrice: fetchNativePrice,
  getTokenImage: fetchTokenImage,
  subscanApiKey: API_KEYS.subscan,
});

['bitcoin', 'polkadot', 'tron', 'dogecoin'].forEach(chainId => {
  app.get(`/api/nfts/${chainId}/:address`, (_req, res) => res.json({ nfts: [] }));
  app.get(`/api/tokens/${chainId}/:address`, async (req, res) => {
    try {
      res.json({ nfts: await nonEvmScanner.scanTokens(chainId, req.params.address) });
    } catch (error) {
      console.error(`❌ ${chainId} balance error:`, error.message);
      res.json({ nfts: [] });
    }
  });
  app.get(`/api/transactions/${chainId}/:address`, async (req, res) => {
    try {
      res.json({ transactions: await nonEvmScanner.scanTransactions(chainId, req.params.address) });
    } catch (error) {
      console.error(`❌ ${chainId} transaction error:`, error.message);
      res.json({ transactions: [] });
    }
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
      const tokens = [];

      // ── Moralis attempt (Monad mainnet chain=0x8f) ────────────────────
      let moralisResult = [];
      let moralisNativeRaw = null;

      const [nativeRes, erc20Res] = await Promise.all([
        fetch(`https://deep-index.moralis.io/api/v2.2/${address}/balance?chain=0x8f`, { headers: moralisHeaders }),
        fetch(`https://deep-index.moralis.io/api/v2.2/${address}/erc20?chain=0x8f`, { headers: moralisHeaders })
      ]);

      if (!nativeRes.ok) {
        const errBody = await nativeRes.text();
        console.error(`❌ Moralis native balance error ${nativeRes.status}:`, errBody);
      } else {
        const nativeData = await nativeRes.json();
        console.log('  Moralis native response:', JSON.stringify(nativeData));
        moralisNativeRaw = nativeData.balance;
      }

      if (!erc20Res.ok) {
        const errBody = await erc20Res.text();
        console.error(`❌ Moralis ERC20 error ${erc20Res.status}:`, errBody);
      } else {
        const erc20Data = await erc20Res.json();
        moralisResult = erc20Data.result || [];
        console.log(`  Moralis returned ${moralisResult.length} ERC20 tokens`);
      }

      // Fetch MON price once — used by native token AND all ERC20 nativePrice calculations
      const monUsdPrice = await fetchNativePrice('MON');

      // Native MON balance (from Moralis)
      if (moralisNativeRaw && moralisNativeRaw !== '0') {
        const balance = parseInt(moralisNativeRaw, 10) / 1e18;
        if (balance > 0) {
          tokens.push({
            id: 'native-mon',
            name: 'Monad',
            symbol: 'MON',
            balance: balance.toFixed(4),
            usdPrice: monUsdPrice,
            nativePrice: '1.0000',
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
          image: t.logo || t.thumbnail || await fetchTokenImageByAddress('monad', t.token_address) || await fetchTokenImage(t.symbol) || '',
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
              return Buffer.from(str, 'hex').toString('utf8').replace(/ /g, '').trim();
            }
          }
          // Fallback: try as bytes32 fixed string
          return Buffer.from(clean.replace(/^0+/, '').padStart(64, '0').slice(0, 64), 'hex')
            .toString('utf8').replace(/ /g, '').trim();
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
              image: await fetchTokenImageByAddress('monad', contractAddr) || await fetchTokenImage(symbol) || '',
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
                  image: await fetchTokenImageByAddress('monad', contractAddr) || await fetchTokenImage(symbol) || '',
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
          ? `https://cloudflare-ipfs.com/ipfs/${rawImage.slice(7)}`
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
                let image = '';
                
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

                // CoinGecko fallback if image still empty after metadata fetch
                if (!image && symbol && symbol !== 'UNKNOWN') {
                  try { image = await fetchTokenImage(symbol); } catch {}
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
    if (addrRes.status === 403) {
      console.error('❌ Blockfrost 403 — invalid or missing API key');
      return res.status(500).json({ error: 'Blockfrost authentication failed — check BLOCKFROST_KEY' });
    }
    if (addrRes.status === 429) {
      console.error('❌ Blockfrost 429 — rate limit hit');
      return res.status(429).json({ error: 'Blockfrost rate limit exceeded — try again shortly' });
    }
    if (!addrRes.ok) {
      const errBody = await addrRes.text();
      console.error(`❌ Blockfrost address lookup failed: ${addrRes.status}`, errBody);
      return res.status(502).json({ error: `Blockfrost error ${addrRes.status}` });
    }
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
      if (assetsRes.ok) {
        const parsed = await assetsRes.json();
        assets = Array.isArray(parsed) ? parsed : [];
        console.log(`  Blockfrost stake assets: ${assets.length} total`);
      } else {
        console.warn(`  ⚠️ Stake assets fetch failed: ${assetsRes.status} — falling back to direct address assets`);
      }
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
        if (!metaRes.ok) {
          if (metaRes.status === 429) console.warn(`  ⚠️ Blockfrost rate limit on asset ${a.unit.substring(0, 16)}…`);
          return null;
        }

        const meta = await metaRes.json();
        if (meta.error || meta.statusCode) return null;
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

// --- Market Data Routes ---
// Top 100 cryptocurrencies with live prices — 5 minute TTL
let _top100Cache = null;
let _top100CacheTs = 0;
const TOP100_TTL = 300000;

// Persist market cache to disk so server restarts don't cause cold-start 500s
const MARKET_CACHE_FILE = path.join(__dirname, 'market-cache.json');
try {
  const raw = fs.readFileSync(MARKET_CACHE_FILE, 'utf8');
  const saved = JSON.parse(raw);
  if (Array.isArray(saved.data) && saved.data.length > 0) {
    _top100Cache = saved.data;
    _top100CacheTs = saved.ts || 0;
    console.log(`📦 Market cache restored from disk: ${saved.data.length} coins`);
  }
} catch (_) { /* no cache file yet */ }

const saveTop100 = (data) => {
  _top100Cache = data;
  _top100CacheTs = Date.now();
  try { fs.writeFileSync(MARKET_CACHE_FILE, JSON.stringify({ data, ts: _top100CacheTs })); } catch (_) {}
};

app.get('/api/market/top100', async (req, res) => {
  if (_top100Cache && Date.now() - _top100CacheTs < TOP100_TTL) {
    console.log('📦 top100 cache hit');
    return res.json(_top100Cache);
  }

  console.log('📊 Fetching top 100 market data...');

  // ── Attempt 1: CoinGecko with sparklines ─────────────────────────────
  try {
    const response = await fetch(
      `${CG_BASE}/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=true&price_change_percentage=24h`,
      { headers: cgHeaders(), signal: AbortSignal.timeout(8000) }
    );
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        console.log(`✅ top100 CoinGecko: ${data.length} coins`);
        saveTop100(data);
        return res.json(data);
      }
    }
    console.warn(`⚠️  CoinGecko top100 ${response.status} — trying CoinMarketCap`);
  } catch (e) {
    console.warn('⚠️  CoinGecko top100 failed:', e.message);
  }

  // ── Attempt 2: CoinMarketCap authenticated REST fallback ───────────────
  try {
    const data = await fetchCmcListings(100);
    console.log(`✅ top100 CoinMarketCap fallback: ${data.length} coins`);
    saveTop100(data);
    return res.json(data);
  } catch (e) {
    console.warn('⚠️  CoinMarketCap top100 fallback failed:', e.message);
  }

  // ── Attempt 3: Binance 24hr ticker (no sparklines, volume-sorted) ─────
  try {
    const r = await fetchBinance('/api/v3/ticker/24hr', 6000);
    if (r && r.ok) {
      const tickers = await r.json();
      const usdtPairs = tickers
        .filter(t => t.symbol.endsWith('USDT') && parseFloat(t.quoteVolume) > 1000000)
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, 100)
        .map((t, i) => {
          const symbol = t.symbol.replace('USDT', '');
          return {
            id: symbol.toLowerCase(), symbol: symbol.toLowerCase(), name: symbol,
            image: '', current_price: parseFloat(t.lastPrice),
            market_cap: parseFloat(t.quoteVolume), market_cap_rank: i + 1,
            price_change_percentage_24h: parseFloat(t.priceChangePercent),
            total_volume: parseFloat(t.quoteVolume),
            high_24h: parseFloat(t.highPrice), low_24h: parseFloat(t.lowPrice),
            sparkline_in_7d: null, source: 'Binance',
          };
        });
      console.log(`✅ top100 Binance fallback: ${usdtPairs.length} coins`);
      saveTop100(usdtPairs);
      return res.json(usdtPairs);
    }
  } catch (e) {
    console.warn('⚠️  Binance top100 fallback failed:', e.message);
  }

  // ── Stale cache beats a 500 ───────────────────────────────────────────
  if (_top100Cache) {
    console.log('⚠️  All sources failed — serving stale cache');
    return res.json(_top100Cache);
  }

  res.status(500).json({ error: 'Market data temporarily unavailable' });
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
    const r = await fetch(`${CG_BASE}/api/v3/search?query=${encodeURIComponent(query)}`, { headers: cgHeaders() });
    if (r.status === 429) { await sleep(3000); }
    const r2 = r.status === 429
      ? await fetch(`${CG_BASE}/api/v3/search?query=${encodeURIComponent(query)}`, { headers: cgHeaders() })
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
        fetch(`${CG_BASE}/api/v3/coins/markets?vs_currency=usd&ids=${meta.id}&sparkline=true&price_change_percentage=24h`, { headers: cgHeaders() }),
        fetch(`${CG_BASE}/api/v3/coins/${meta.id}/market_chart?vs_currency=usd&days=7`, { headers: cgHeaders() })
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
          `${CG_BASE}/api/v3/simple/price?ids=${meta.id}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`,
          { headers: cgHeaders() }
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

  // Step 3: CoinMarketCap — authenticated REST fallback for broad market coverage
  try {
    const cmcCoin = await fetchCmcQuote(meta?.symbol || query);
    const coin = {
      ...cmcCoin,
      id: meta?.id || cmcCoin.id,
      symbol: (meta?.symbol || cmcCoin.symbol || query).toUpperCase(),
      name: meta?.name || cmcCoin.name,
      image: meta?.image || cmcCoin.image,
      market_cap_rank: meta?.rank || cmcCoin.market_cap_rank,
    };
    console.log(`  ✅ CoinMarketCap: ${coin.name} #${coin.market_cap_rank} $${coin.current_price}`);
    return res.json(save(coin));
  } catch (e) { console.log(`  ❌ CoinMarketCap search: ${e.message}`); }

  // Step 4: DefiLlama — covers DeFi tokens that CoinGecko rate-limits or misses
  // Uses coingecko:{id} prefix if we have meta, otherwise tries symbol search
  try {
    const llamaId = meta?.id ? `coingecko:${meta.id}` : null;
    if (llamaId) {
      const r = await fetch(`https://coins.llama.fi/prices/current/${encodeURIComponent(llamaId)}`);
      if (r.ok) {
        const d = await r.json();
        const entry = d?.coins?.[llamaId];
        if (entry?.price > 0) {
          const coin = {
            id: meta.id, name: meta.name, symbol: meta.symbol || entry.symbol?.toUpperCase() || ticker,
            current_price: entry.price,
            price_change_percentage_24h: 0,
            market_cap: 0, market_cap_rank: meta?.rank || null,
            image: meta?.image || '',
            sparkline_in_7d: null,
            total_volume: 0, high_24h: 0, low_24h: 0,
            source: 'DefiLlama',
          };
          console.log(`  ✅ DefiLlama: ${coin.name} $${entry.price}`);
          return res.json(save(coin));
        }
      }
    }
  } catch (e) { console.log(`  ❌ DefiLlama market search: ${e.message}`); }

  // Step 5: Binance — real-time price for any symbol listed on Binance
  try {
    const bSymbol = (meta?.symbol || query.toUpperCase()) + 'USDT';
    const r = await fetchBinance(`/api/v3/ticker/24hr?symbol=${bSymbol}`);
    if (r) {
      const t = await r.json();
      if (t.lastPrice && parseFloat(t.lastPrice) > 0) {
        const price = parseFloat(t.lastPrice);
        const coin = {
          id: meta?.id || query.toLowerCase(),
          name: meta?.name || (meta?.symbol || query.toUpperCase()),
          symbol: meta?.symbol || query.toUpperCase(),
          current_price: price,
          price_change_percentage_24h: parseFloat(t.priceChangePercent) || 0,
          high_24h: parseFloat(t.highPrice) || 0,
          low_24h: parseFloat(t.lowPrice) || 0,
          total_volume: parseFloat(t.quoteVolume) || 0,
          market_cap: 0, market_cap_rank: meta?.rank || null,
          image: meta?.image || '',
          sparkline_in_7d: null,
          source: 'Binance',
        };
        console.log(`  ✅ Binance: ${coin.symbol} $${price}`);
        return res.json(save(coin));
      }
    }
  } catch (e) { console.log(`  ❌ Binance search: ${e.message}`); }

  // Step 6: DexScreener — DEX-traded tokens (Monad memecoins, Base tokens, etc.)
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const json = await r.json();
      const pairs = (json.pairs || []).sort((a, b) => parseFloat(b.volume?.h24 || 0) - parseFloat(a.volume?.h24 || 0));
      const pair = pairs.find(p => parseFloat(p.priceUsd) > 0);
      if (pair) {
        const coin = {
          id: pair.baseToken.address.toLowerCase(),
          symbol: pair.baseToken.symbol.toUpperCase(),
          name: pair.baseToken.name,
          image: pair.info?.imageUrl || meta?.image || '',
          current_price: parseFloat(pair.priceUsd),
          price_change_percentage_24h: parseFloat(pair.priceChange?.h24) || 0,
          market_cap: parseFloat(pair.marketCap || pair.fdv) || 0,
          market_cap_rank: meta?.rank || null,
          total_volume: parseFloat(pair.volume?.h24) || 0,
          sparkline_in_7d: null, high_24h: 0, low_24h: 0,
          source: 'DexScreener',
        };
        console.log(`  ✅ DexScreener: ${coin.name} $${coin.current_price}`);
        return res.json(save(coin));
      }
    }
  } catch (e) { console.log(`  ❌ DexScreener: ${e.message}`); }

  // Step 7: Kraken (major coins, ticker only)
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

  // Step 8: Gemini
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

  // Stale cache beats a 404
  if (_searchCache[cacheKey]) {
    console.log(`  ⚠️  All sources failed — serving stale cache for: ${query}`);
    return res.json(_searchCache[cacheKey].data);
  }

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
      const binancePath = `/api/v3/klines?symbol=${binanceSymbol}&interval=${config.binanceInterval}&limit=${config.binanceLimit}`;
      const binanceRes = await fetchBinance(binancePath);
      const binanceData = binanceRes ? await binanceRes.json() : null;
      
      if (binanceData && Array.isArray(binanceData) && binanceData.length > 0) {
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
      const cgUrl = `${CG_BASE}/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${config.days}`;
      const cgRes = await fetch(cgUrl, { headers: cgHeaders(), signal: AbortSignal.timeout(8000) });
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

    // Step 5: Try CoinMarketCap authenticated historical quotes
    console.log('  📈 Trying CoinMarketCap...');
    try {
      const formattedPrices = await fetchCmcChart(symbol, config);
      const currentPrice = formattedPrices[formattedPrices.length - 1].price;
      const startPrice = formattedPrices[0].price;
      const change = ((currentPrice - startPrice) / startPrice) * 100;

      console.log(`  ✅ CoinMarketCap: ${formattedPrices.length} data points`);
      return res.json({
        symbol: symbol,
        name: input.toUpperCase(),
        prices: formattedPrices,
        current_price: currentPrice,
        change_24h: change,
        source: 'CoinMarketCap',
        timeframe: timeframe
      });
    } catch (e) {
      console.log(`  ❌ CoinMarketCap chart error: ${e.message}`);
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
const nativeCurrencies = Object.fromEntries(
  SCANNER_CHAINS.map(chain => [chain.id, chain.native])
);

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

// Serve app-hub-data.js from root (editable app hub data, separate from public/)
app.get('/app-hub-data.js', (req, res) => res.sendFile(path.join(__dirname, 'app-hub-data.js')));

app.get('/docs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'docs.html')));

// Digital Asset Links — proves the MagicMoney Android app may use passkeys under
// this domain. Android fetches this before every WebAuthn ceremony in the app, so
// it must return JSON, not the SPA shell. Needs an explicit route because
// express.static defaults to dotfiles:'ignore', which drops every /.well-known/
// path through to the catch-all below. Contents are public (package names +
// signing-certificate fingerprints); no secrets.
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.type('application/json')
     .sendFile(path.join(__dirname, 'public', '.well-known', 'assetlinks.json'));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// Validate critical API keys at startup
if (!API_KEYS.alchemy) {
  console.error('⚠️  WARNING: ALCHEMY_KEY not found in .env file!');
  console.error('   EVM chains (Ethereum, Optimism, etc.) will not work without it.');
} else {
  console.log('✅ Alchemy API key loaded');
}
if (!API_KEYS.blockfrost) {
  console.error('⚠️  WARNING: BLOCKFROST_KEY not found in .env file!');
  console.error('   Cardano NFTs and tokens will not work without it.');
} else {
  console.log(`✅ Blockfrost API key loaded (${API_KEYS.blockfrost.substring(0, 15)}…)`);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  // Pre-warm the market cache so the first page load is instant
  fetch(`http://localhost:${PORT}/api/market/top100`)
    .then(() => console.log('✅ Market cache pre-warmed'))
    .catch(e => console.warn('⚠️  Market cache pre-warm failed:', e.message));
});
