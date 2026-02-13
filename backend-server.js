require('dotenv').config();
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
  zerion: process.env.ZERION_KEY
};

// --- Price Discovery Helper ---
const fetchUSDPrice = async (chainId, address) => {
  try {
    const chainMap = { 
      'ethereum': 'ethereum', 'base': 'base', 'polygon': 'polygon', 
      'abstract': 'abstract', 'monad': 'monad', 'solana': 'solana', 'cardano': 'cardano' 
    };
    const dsChain = chainMap[chainId] || chainId;
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await res.json();
    const pair = data.pairs?.find(p => p.chainId === dsChain) || data.pairs?.[0];
    return pair ? parseFloat(pair.priceUsd) : 0;
  } catch (e) { return 0; }
};

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
    const res = await fetch(url);
    const data = await res.json();
    
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
    return []; 
  }
};

const fetchAlchemyTokens = async (network, address, chainId) => {
  try {
    const baseUrl = `https://${network}.g.alchemy.com/v2/${API_KEYS.alchemy}`;
    
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

    let nativeSymbol = 'ETH', nativeName = 'Ether', nativeLogo = 'https://cryptologos.cc/logos/ethereum-eth-logo.png';
    let nativePriceAddr = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'; 

    if (chainId === 'polygon') {
      nativeSymbol = 'MATIC'; nativeName = 'Polygon'; nativeLogo = 'https://cryptologos.cc/logos/polygon-matic-logo.png';
      nativePriceAddr = '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270';
    }

    const nativeUsdPrice = await fetchUSDPrice(chainId, nativePriceAddr);

    if (nativeRes.result) {
      const balance = parseInt(nativeRes.result, 16) / 1e18;
      if (balance > 0) {
        tokens.push({
          id: 'native',
          name: nativeName,
          symbol: nativeSymbol,
          balance: balance.toFixed(4),
          usdPrice: nativeUsdPrice,
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
          totalValue: (balance * usdPrice).toFixed(2),
          image: metadata.logo || `https://via.placeholder.com/400/334155/ffffff?text=${metadata.symbol || '$'}`,
          chain: chainId,
          isToken: true
        };
      } catch (e) { return null; }
    }));

    return [...tokens, ...erc20Results.filter(t => t !== null)];
  } catch (e) { return []; }
};

// --- Routes ---
const evmChains = [
  { id: 'ethereum', net: 'eth-mainnet' },
  { id: 'abstract', net: 'abstract-mainnet' },
  { id: 'base', net: 'base-mainnet' },
  { id: 'polygon', net: 'polygon-mainnet' }
];

evmChains.forEach(chain => {
  app.get(`/api/nfts/${chain.id}/:address`, (req, res) => fetchAlchemyNFTs(chain.net, req.params.address, chain.id).then(n => res.json({ nfts: n })));
  app.get(`/api/tokens/${chain.id}/:address`, (req, res) => fetchAlchemyTokens(chain.net, req.params.address, chain.id).then(t => res.json({ nfts: t })));
});

// --- Monad (via Zerion API) ---
app.get('/api/:mode(nfts|tokens)/monad/:address', async (req, res) => {
  const { mode, address } = req.params;
  try {
    console.log(`📡 Fetching Monad ${mode} for ${address} via Zerion...`);
    
    const response = await fetch(`https://api.zerion.io/v1/wallets/${address}/positions/?currency=usd&filter[chain_ids]=monad-devnet&filter[positions]=only_simple&sort=value`, {
      headers: {
        'Authorization': `Basic ${Buffer.from(API_KEYS.zerion + ':').toString('base64')}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.error(`❌ Zerion API error: ${response.status}`);
      return res.json({ nfts: [] });
    }

    const data = await response.json();
    const positions = data.data || [];
    console.log(`✅ Found ${positions.length} positions on Monad`);

    if (mode === 'tokens') {
      // Filter for fungible tokens
      const tokens = positions
        .filter(p => p.attributes?.fungible_info && parseFloat(p.attributes.quantity?.float || 0) > 0)
        .map(p => {
          const info = p.attributes.fungible_info;
          const quantity = parseFloat(p.attributes.quantity?.float || 0);
          const price = parseFloat(p.attributes.price || 0);
          
          return {
            id: info.implementations?.[0]?.address || p.id,
            name: info.name || 'Unknown Token',
            symbol: info.symbol || '???',
            balance: quantity.toFixed(4),
            usdPrice: price,
            totalValue: (quantity * price).toFixed(2),
            image: info.icon?.url || 'https://via.placeholder.com/400/836EF9/ffffff?text=MON',
            chain: 'monad',
            isToken: true
          };
        })
        .filter(t => parseFloat(t.balance) > 0);

      res.json({ nfts: tokens });
    } else {
      // Filter for NFTs
      const nfts = positions
        .filter(p => p.attributes?.nft_info)
        .map(p => {
          const info = p.attributes.nft_info;
          
          return {
            id: `${info.contract_address}-${info.token_id}`,
            name: info.name || 'Monad NFT',
            image: info.content?.preview?.url || info.content?.detail?.url || 'https://via.placeholder.com/400/836EF9/ffffff?text=NFT',
            collection: info.collection?.name || 'Monad Collection',
            chain: 'monad',
            contractAddress: info.contract_address,
            tokenId: info.token_id,
            isToken: false,
            metadata: {
              traits: info.attributes || [],
              description: info.description || ''
            }
          };
        });

      res.json({ nfts });
    }
  } catch (err) {
    console.error('❌ Monad Zerion error:', err);
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
    const adaPrice = await fetchUSDPrice('cardano', 'cardano');
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
      const usdPrice = await fetchUSDPrice('cardano', a.unit);
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

// Search for specific coin using DIA
app.get('/api/market/search/:query', async (req, res) => {
  const query = req.params.query.toUpperCase();
  console.log(`🔍 Searching for: ${query}`);
  
  try {
    // Try DIA first
    const diaResponse = await fetch(`https://api.diadata.org/v1/quotation/${query}`);
    const diaData = await diaResponse.json();
    
    if (diaData.Price && diaData.Price > 0) {
      console.log(`✅ Found ${query} on DIA: $${diaData.Price}`);
      res.json({
        symbol: diaData.Symbol,
        name: diaData.Name || query,
        price: diaData.Price,
        change_24h: 0, // DIA doesn't provide 24h change in this endpoint
        source: 'DIA',
        time: diaData.Time
      });
    } else {
      // Fallback to CoinGecko search
      console.log(`⚠️ DIA failed for ${query}, trying CoinGecko...`);
      const cgResponse = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${query.toLowerCase()}`);
      const cgData = await cgResponse.json();
      
      if (cgData && cgData.length > 0) {
        const coin = cgData[0];
        console.log(`✅ Found ${query} on CoinGecko: $${coin.current_price}`);
        res.json({
          symbol: coin.symbol.toUpperCase(),
          name: coin.name,
          price: coin.current_price,
          change_24h: coin.price_change_percentage_24h || 0,
          source: 'CoinGecko'
        });
      } else {
        res.status(404).json({ error: 'Coin not found' });
      }
    }
  } catch (err) {
    console.error(`❌ Search error for ${query}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get historical chart data (7 days)
app.get('/api/market/chart/:coinIdOrSymbol', async (req, res) => {
  const input = req.params.coinIdOrSymbol.toLowerCase();
  console.log(`📈 Fetching chart for: ${input}`);
  
  // Symbol to CoinGecko ID mapping for top coins
  const symbolToId = {
    'btc': 'bitcoin',
    'eth': 'ethereum',
    'usdt': 'tether',
    'bnb': 'binancecoin',
    'sol': 'solana',
    'usdc': 'usd-coin',
    'xrp': 'ripple',
    'doge': 'dogecoin',
    'ton': 'the-open-network',
    'ada': 'cardano',
    'avax': 'avalanche-2',
    'shib': 'shiba-inu',
    'dot': 'polkadot',
    'link': 'chainlink',
    'trx': 'tron',
    'matic': 'matic-network',
    'dai': 'dai',
    'ltc': 'litecoin',
    'bch': 'bitcoin-cash',
    'uni': 'uniswap',
    'atom': 'cosmos',
    'xlm': 'stellar',
    'okb': 'okb',
    'icp': 'internet-computer',
    'fil': 'filecoin',
    'apt': 'aptos',
    'hbar': 'hedera-hashgraph',
    'arb': 'arbitrum',
    'vet': 'vechain',
    'near': 'near',
    'op': 'optimism',
    'inj': 'injective-protocol',
    'stx': 'blockstack',
    'grt': 'the-graph',
    'ftm': 'fantom',
    'algo': 'algorand',
    'aave': 'aave',
    'etc': 'ethereum-classic'
  };
  
  // Try to convert symbol to ID, or use input as-is if it's already an ID
  const coinId = symbolToId[input] || input;
  
  try {
    console.log(`🔍 Using CoinGecko ID: ${coinId}`);
    const response = await fetch(
      `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=7&interval=hourly`
    );
    
    if (!response.ok) {
      throw new Error(`Chart API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (!data.prices || data.prices.length === 0) {
      throw new Error('No price data available');
    }
    
    // Format data for frontend
    const formattedPrices = data.prices.map(([time, price]) => ({
      time,
      price
    }));
    
    const currentPrice = formattedPrices[formattedPrices.length - 1].price;
    const yesterdayPrice = formattedPrices[formattedPrices.length - 25]?.price || currentPrice;
    const change24h = ((currentPrice - yesterdayPrice) / yesterdayPrice) * 100;
    
    console.log(`✅ Chart data for ${input.toUpperCase()}: ${formattedPrices.length} data points`);
    
    res.json({
      symbol: input.toUpperCase(),
      name: input.toUpperCase(),
      prices: formattedPrices,
      current_price: currentPrice,
      change_24h: change24h
    });
  } catch (err) {
    console.error(`❌ Chart error for ${input}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));