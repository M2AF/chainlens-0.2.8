require('dotenv').config({ path: __dirname + '/.env' });
const _envCheck = { moralis: !!process.env.MORALIS_KEY, alchemy: !!process.env.ALCHEMY_KEY, cwd: process.cwd(), dir: __dirname };
console.log('🔑 ENV check:', JSON.stringify(_envCheck));
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

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

        return {
          id: token.contractAddress,
          name: metadata.name || 'Unknown',
          symbol: metadata.symbol || '???',
          balance: balance.toFixed(4),
          usdPrice: usdPrice,
          nativePrice: toNativePrice(usdPrice * balance, nativeUsdPrice),
          totalValue: (balance * usdPrice).toFixed(2),
          image: metadata.logo || `https://via.placeholder.com/400/334155/ffffff?text=${metadata.symbol || '$'}`,
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
            nativePrice: balance.toFixed(4),
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
        return {
          id: t.token_address,
          name: t.name || 'Unknown Token',
          symbol: t.symbol || '???',
          balance: balance.toFixed(4),
          usdPrice,
          nativePrice: toNativePrice(usdPrice * balance, monUsdPrice),
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
              return Buffer.from(str, 'hex').toString('utf8').replace(//g, '').trim();
            }
          }
          // Fallback: try as bytes32 fixed string
          return Buffer.from(clean.replace(/^0+/, '').padStart(64, '0').slice(0, 64), 'hex')
            .toString('utf8').replace(//g, '').trim();
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
            return {
              id: contractAddr,
              name,
              symbol,
              balance: balance.toFixed(4),
              usdPrice,
              nativePrice: toNativePrice(usdPrice * balance, monUsdPrice),
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
                return {
                  id: contractAddr, name, symbol,
                  balance: balance.toFixed(4), usdPrice,
                  totalValue: (balance * usdPrice).toFixed(2),
                  nativePrice: toNativePrice(usdPrice * balance, monUsdPrice),
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
    const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${API_KEYS.helius}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'sol-scan', method: 'getAssetsByOwner',
        params: { ownerAddress: address, page: 1, limit: 100, options: { showFungible: mode === 'tokens', showNativeBalance: mode === 'tokens' } }
      })
    });
    const data = await response.json();
    const items = data.result?.items || [];

    if (mode === 'tokens') {
      const tokens = items.filter(i => i.interface === 'FungibleToken' || i.interface === 'FungibleAsset').map(t => {
        const balanceNum = (t.token_info?.balance / Math.pow(10, t.token_info?.decimals || 0));
        const usdPrice = t.token_info?.price_info?.price_per_token || 0;
        return {
          id: t.id,
          name: t.content?.metadata?.name || 'Solana Token',
          symbol: t.content?.metadata?.symbol || 'SOL',
          balance: balanceNum.toFixed(4),
          usdPrice: usdPrice,
          nativePrice: toNativePrice(usdPrice * balanceNum, solPrice),
          totalValue: (balanceNum * usdPrice).toFixed(2),
          image: t.content?.links?.image || 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
          chain: 'solana',
          isToken: true
        };
      });
      res.json({ nfts: tokens.filter(t => parseFloat(t.balance) > 0) });
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
    const adaPrice = await fetchCoinGeckoPrice('cardano'); // CoinGecko — DexScreener doesn't support Cardano
    const addrRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/addresses/${address}`, { headers: { project_id: API_KEYS.blockfrost } });
    if (addrRes.status === 404) return res.json({ nfts: [] });
    const addrData = await addrRes.json();
    if (!addrData.stake_address) return res.json({ nfts: [] });
    const assetsRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/accounts/${addrData.stake_address}/addresses/assets`, { headers: { project_id: API_KEYS.blockfrost } });
    const assets = await assetsRes.json();
    const tasks = assets.slice(0, 30).map(async (a) => {
      const metaRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/assets/${a.unit}`, { headers: { project_id: API_KEYS.blockfrost } });
      const meta = await metaRes.json();
      const isNFT = parseInt(a.quantity) === 1;
      if ((mode === 'tokens' && isNFT) || (mode === 'nfts' && !isNFT)) return null;
      // Cardano token price: use known CoinGecko ID if available, else 0
      const _ticker = meta.metadata?.ticker || meta.onchain_metadata?.ticker || '';
      const _cgId = NATIVE_CG_IDS[_ticker?.toUpperCase()];
      const usdPrice = _cgId ? await fetchCoinGeckoPrice(_cgId) : 0;
      const balance = (parseInt(a.quantity) / Math.pow(10, meta.metadata?.decimals || 0));
      let img = meta.onchain_metadata?.image || '';
      if (Array.isArray(img)) img = img.join('');
      const imageUrl = img ? (img.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${img.replace('ipfs://', '')}` : (img.startsWith('http') ? img : `https://ipfs.io/ipfs/${img}`)) : '';
      return {
        id: a.unit,
        name: meta.onchain_metadata?.name || meta.asset_name || 'Cardano Asset',
        chain: 'cardano',
        image: imageUrl || 'https://via.placeholder.com/400/0033AD/ffffff?text=ADA',
        balance: mode === 'tokens' ? balance.toFixed(2) : null,
        usdPrice: usdPrice,
        nativePrice: toNativePrice(usdPrice * balance, adaPrice),
        totalValue: (balance * usdPrice).toFixed(2),
        symbol: meta.metadata?.ticker || '',
        isToken: mode === 'tokens',
        metadata: { traits: meta.onchain_metadata?.attributes || [], description: meta.onchain_metadata?.description || '' }
      };
    });
    const results = await Promise.all(tasks);
    res.json({ nfts: results.filter(n => n !== null) });
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
app.get('/api/market/search/:query', async (req, res) => {
  const query = req.params.query;
  console.log(`🔍 Searching for: ${query}`);
  
  try {
    // Step 1: Try CoinGecko search (most comprehensive)
    console.log('  📊 Trying CoinGecko...');
    try {
      const searchRes = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`);
      
      // Check for rate limiting
      if (searchRes.status === 429) {
        console.log('  ⚠️  CoinGecko rate limited, trying Kraken...');
        throw new Error('Rate limited');
      }
      
      const searchData = await searchRes.json();
      const hit = searchData.coins?.[0];
      
      if (hit) {
        const marketRes = await fetch(
          `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${hit.id}&sparkline=true&price_change_percentage=24h`
        );
        
        if (marketRes.status === 429) {
          console.log('  ⚠️  CoinGecko rate limited, trying Kraken...');
          throw new Error('Rate limited');
        }
        
        const marketData = await marketRes.json();
        
        if (marketData && marketData.length > 0) {
          const coin = marketData[0];
          console.log(`  ✅ CoinGecko: ${coin.name} (${coin.id}) $${coin.current_price}`);
          return res.json({
            ...coin,
            source: 'CoinGecko',
            symbol: coin.symbol.toUpperCase()
          });
        }
      }
    } catch (e) {
      console.log(`  ❌ CoinGecko: ${e.message}`);
    }
    
    // Step 2: Try Kraken
    console.log('  🐙 Trying Kraken...');
    try {
      const krakenSymbol = query.toUpperCase() + 'USD';
      const krakenRes = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${krakenSymbol}`);
      const krakenData = await krakenRes.json();
      
      if (krakenData.result && Object.keys(krakenData.result).length > 0) {
        const pairKey = Object.keys(krakenData.result)[0];
        const ticker = krakenData.result[pairKey];
        const price = parseFloat(ticker.c[0]);
        const high24h = parseFloat(ticker.h[1]);
        const low24h = parseFloat(ticker.l[1]);
        const volume24h = parseFloat(ticker.v[1]);
        const change24h = ((price - parseFloat(ticker.o)) / parseFloat(ticker.o)) * 100;
        
        console.log(`  ✅ Kraken: ${query.toUpperCase()} $${price}`);
        return res.json({
          id: query.toLowerCase(),
          symbol: query.toUpperCase(),
          name: query.toUpperCase(),
          current_price: price,
          price_change_percentage_24h: change24h,
          high_24h: high24h,
          low_24h: low24h,
          total_volume: volume24h,
          market_cap: 0,
          market_cap_rank: null,
          image: `https://cryptoicons.org/api/icon/${query.toLowerCase()}/50`,
          sparkline_in_7d: null,
          source: 'Kraken'
        });
      } else {
        console.log(`  ❌ Kraken: ${krakenData.error?.[0] || 'Pair not found'}`);
      }
    } catch (e) {
      console.log(`  ❌ Kraken error: ${e.message}`);
    }
    
    // Step 3: Try Gemini
    console.log('  💎 Trying Gemini...');
    try {
      const geminiSymbol = query.toLowerCase() + 'usd';
      const geminiRes = await fetch(`https://api.gemini.com/v1/pubticker/${geminiSymbol}`);
      
      if (geminiRes.ok) {
        const geminiData = await geminiRes.json();
        const price = parseFloat(geminiData.last);
        const change = parseFloat(geminiData.change || 0);
        const volume = parseFloat(geminiData.volume?.[query.toUpperCase()] || 0);
        
        console.log(`  ✅ Gemini: ${query.toUpperCase()} $${price}`);
        return res.json({
          id: query.toLowerCase(),
          symbol: query.toUpperCase(),
          name: query.toUpperCase(),
          current_price: price,
          price_change_percentage_24h: change,
          high_24h: 0,
          low_24h: 0,
          total_volume: volume,
          market_cap: 0,
          market_cap_rank: null,
          image: `https://cryptoicons.org/api/icon/${query.toLowerCase()}/50`,
          sparkline_in_7d: null,
          source: 'Gemini'
        });
      } else {
        console.log(`  ❌ Gemini: HTTP ${geminiRes.status}`);
      }
    } catch (e) {
      console.log(`  ❌ Gemini error: ${e.message}`);
    }
    
    // Step 4: No results from any source
    console.log(`  ❌ Not found on any exchange`);
    return res.status(404).json({ error: `Coin "${query}" not found on any supported exchange` });
    
  } catch (err) {
    console.error(`❌ Search error for ${query}:`, err.message);
    res.status(500).json({ error: err.message });
  }
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

// EVM chains transaction history using Alchemy
evmChains.forEach(chain => {
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
            category: ['external', 'internal', 'erc20'], // Removed erc721/erc1155 (NFTs)
            maxCount: '0x32', // 50 transactions
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
            category: ['external', 'internal', 'erc20'], // Removed erc721/erc1155 (NFTs)
            maxCount: '0x32',
            order: 'desc'
          }]
        })
      });
      
      const receivedData = await receivedRes.json();
      
      const sentTxs = (sentData.result?.transfers || [])
        .filter(tx => tx.value && parseFloat(tx.value) > 0) // Only transactions with value
        .map(tx => ({
          hash: tx.hash,
          type: 'sent',
          from: tx.from,
          to: tx.to,
          value: parseFloat(tx.value),
          asset: tx.asset || nativeCurrencies[chain.id] || 'ETH',
          category: tx.category,
          timestamp: tx.metadata?.blockTimestamp ? new Date(tx.metadata.blockTimestamp).getTime() : Date.now(),
          chain: chain.id,
          rawContract: tx.rawContract
        }));
      
      const receivedTxs = (receivedData.result?.transfers || [])
        .filter(tx => tx.value && parseFloat(tx.value) > 0) // Only transactions with value
        .map(tx => ({
          hash: tx.hash,
          type: tx.from.toLowerCase() === address.toLowerCase() ? 'self' : 'received',
          from: tx.from,
          to: tx.to,
          value: parseFloat(tx.value),
          asset: tx.asset || nativeCurrencies[chain.id] || 'ETH',
        category: tx.category,
        timestamp: tx.metadata?.blockTimestamp ? new Date(tx.metadata.blockTimestamp).getTime() : Date.now(),
        chain: chain.id,
        rawContract: tx.rawContract
      }));
      
      // Combine and sort by timestamp
      const allTxs = [...sentTxs, ...receivedTxs]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 50);
      
      console.log(`✅ ${chain.id}: Found ${allTxs.length} transactions`);
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
    
    // Parse Helius enhanced transactions
    const transactions = txList.map(tx => {
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
      
      return {
        hash: tx.signature,
        type: type,
        from: type === 'received' ? '' : address,
        to: type === 'sent' ? '' : address,
        value: value,
        asset: asset,
        category: 'transaction',
        timestamp: tx.timestamp ? tx.timestamp * 1000 : Date.now(),
        chain: 'solana',
        fee: tx.fee ? tx.fee / 1e9 : 0
      };
    });
    
    console.log(`✅ Returning ${transactions.length} parsed transactions`);
    console.log(`📝 Sample parsed tx:`, transactions[0]);
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
      const errText = await response.text();
      console.error(`❌ Moralis error ${response.status}:`, errText.substring(0, 500));
      
      // Try alternative endpoint
      console.log(`🔄 Trying alternative endpoint...`);
      const altUrl = `https://deep-index.moralis.io/api/v2/${address}?chain=0x8f`;
      console.log(`🔗 Calling: ${altUrl}`);
      
      const altResponse = await fetch(altUrl, {
        headers: {
          'accept': 'application/json',
          'X-API-Key': API_KEYS.moralis
        }
      });
      
      console.log(`📥 Alt response status: ${altResponse.status}`);
      
      if (!altResponse.ok) {
        const altErrText = await altResponse.text();
        console.error(`❌ Alt endpoint also failed:`, altErrText.substring(0, 500));
        console.log(`========================================\n`);
        return res.json({ transactions: [] });
      }
      
      const altData = await altResponse.json();
      console.log(`📦 Alt response keys:`, Object.keys(altData));
      console.log(`📦 Alt response sample:`, JSON.stringify(altData).substring(0, 300));
      console.log(`⚠️ Alt endpoint returned data but no transaction list`);
      console.log(`========================================\n`);
      return res.json({ transactions: [] });
    }
    
    const data = await response.json();
    console.log(`📦 Response keys:`, Object.keys(data));
    console.log(`📦 Response sample:`, JSON.stringify(data).substring(0, 300));
    
    const txList = data.result || data.transactions || [];
    console.log(`📝 Transaction count: ${txList.length}`);
    
    if (txList.length > 0) {
      console.log(`📝 Sample transaction:`, JSON.stringify(txList[0]).substring(0, 200));
    }
    
    const transactions = txList.map(tx => {
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
        timestamp: tx.block_timestamp ? new Date(tx.block_timestamp).getTime() : Date.now(),
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