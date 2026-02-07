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
  helius: process.env.HELIUS_KEY || "95f83906-d8dc-4e2e-a408-d5e6930d8cea", 
  unstoppable: process.env.UNSTOPPABLE_KEY
};

// --- Mock Price Fetcher (In production, replace with CoinGecko API) ---
const getPrice = (symbol) => {
  const prices = { 
    'ETH': 2640.50, 'SOL': 145.20, 'ADA': 0.58, 'MATIC': 0.72, 
    'MON': 1.20, 'ABS': 0.85, 'USDC': 1.00, 'USDT': 1.00 
  };
  return prices[symbol.toUpperCase()] || (Math.random() * 5); // Fallback for small tokens
};

// --- Unstoppable Domains Resolution ---
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

// --- EVM NFT Helper (Updated with Pricing) ---
const fetchAlchemyNFTs = async (network, address, chainId) => {
  try {
    const res = await fetch(`https://${network}.g.alchemy.com/nft/v3/${API_KEYS.alchemy}/getNFTsForOwner?owner=${address}&withMetadata=true`);
    const data = await res.json();
    return (data.ownedNfts || []).map(nft => ({
      id: `${chainId}-${nft.contract.address}-${nft.tokenId}`,
      name: nft.name || nft.title || 'Unnamed NFT',
      image: nft.image?.cachedUrl || nft.image?.thumbnailUrl || nft.image?.originalUrl || '',
      collection: nft.contract.name || 'Collection',
      chain: chainId,
      isToken: false,
      usdPrice: (Math.random() * 120).toFixed(2), // Simulated Floor Price
      metadata: { traits: nft.raw?.metadata?.attributes || [], description: nft.description || '' }
    }));
  } catch (e) { return []; }
};

// --- EVM Token Helper (Updated with Native + Pricing) ---
const fetchAlchemyTokens = async (network, address, chainId) => {
  try {
    const baseUrl = `https://${network}.g.alchemy.com/v2/${API_KEYS.alchemy}`;
    const nativeRes = await fetch(baseUrl, { method: 'POST', body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [address, "latest"], id: 1 }) }).then(r => r.json());
    const erc20Res = await fetch(baseUrl, { method: 'POST', body: JSON.stringify({ jsonrpc: "2.0", method: "alchemy_getTokenBalances", params: [address], id: 2 }) }).then(r => r.json());

    const tokens = [];
    if (nativeRes.result) {
      const balance = parseInt(nativeRes.result, 16) / 1e18;
      if (balance > 0.0001) {
        let sym = 'ETH'; let name = 'Ethereum';
        if (chainId === 'monad') { sym = 'MON'; name = 'Monad'; }
        if (chainId === 'polygon') { sym = 'MATIC'; name = 'Polygon'; }
        const price = getPrice(sym);
        tokens.push({
          id: 'native', name, symbol: sym, balance: balance.toFixed(4),
          usdPrice: price.toFixed(2), totalValue: (balance * price).toFixed(2),
          image: chainId === 'monad' ? 'https://pbs.twimg.com/profile_images/1691568696803713024/Sw_hQ2yT_400x400.jpg' : 'https://cryptologos.cc/logos/ethereum-eth-logo.png',
          chain: chainId, isToken: true
        });
      }
    }

    const balances = erc20Res.result?.tokenBalances || [];
    const erc20Tasks = balances.filter(t => parseInt(t.tokenBalance, 16) > 0).map(async (token) => {
      const meta = await fetch(baseUrl, { method: 'POST', body: JSON.stringify({ jsonrpc: "2.0", method: "alchemy_getTokenMetadata", params: [token.contractAddress], id: 3 }) }).then(r => r.json());
      const m = meta.result;
      const bal = parseInt(token.tokenBalance, 16) / Math.pow(10, m.decimals || 18);
      const price = getPrice(m.symbol || '');
      return bal > 0.000001 ? {
        id: token.contractAddress, name: m.name, symbol: m.symbol, balance: bal.toFixed(4),
        usdPrice: price.toFixed(2), totalValue: (bal * price).toFixed(2),
        image: m.logo || `https://via.placeholder.com/100?text=${m.symbol}`, chain: chainId, isToken: true
      } : null;
    });

    const results = await Promise.all(erc20Tasks);
    return [...tokens, ...results.filter(t => t !== null)];
  } catch (e) { return []; }
};

// ... Standard Solana/Cardano Routes updated with getPrice calls ...
app.get('/api/:mode(nfts|tokens)/solana/:address', async (req, res) => {
  const { mode, address } = req.params;
  try {
    const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${API_KEYS.helius}`, {
      method: 'POST', body: JSON.stringify({
        jsonrpc: '2.0', id: 'sol', method: 'getAssetsByOwner',
        params: { ownerAddress: address, displayOptions: { showFungible: mode==='tokens', showNativeBalance: mode==='tokens' } }
      })
    }).then(r => r.json());
    
    const items = response.result?.items || [];
    const results = items.map(t => {
      const isFungible = t.interface === 'FungibleToken' || t.interface === 'FungibleAsset';
      if (mode === 'tokens' && !isFungible) return null;
      if (mode === 'nfts' && isFungible) return null;

      const sym = t.content?.metadata?.symbol || (isFungible ? 'SOL' : '');
      const price = getPrice(sym || 'SOL');
      const bal = isFungible ? (t.token_info?.balance / Math.pow(10, t.token_info?.decimals || 0)) : null;

      return {
        id: t.id, name: t.content?.metadata?.name || 'Solana Asset', symbol: sym,
        balance: bal?.toFixed(4), usdPrice: price.toFixed(2), 
        totalValue: bal ? (bal * price).toFixed(2) : price.toFixed(2),
        image: t.content?.links?.image || 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
        chain: 'solana', isToken: isFungible
      };
    }).filter(x => x);
    res.json({ nfts: results });
  } catch (e) { res.json({ nfts: [] }); }
});

// Cardano Route also updated with Pricing logic
app.get('/api/:mode(nfts|tokens)/cardano/:address', async (req, res) => {
  const { mode, address } = req.params;
  try {
    const addrRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/addresses/${address}`, { headers: { project_id: API_KEYS.blockfrost } }).then(r => r.json());
    if (!addrRes.stake_address) return res.json({ nfts: [] });
    const assets = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/accounts/${addrRes.stake_address}/addresses/assets`, { headers: { project_id: API_KEYS.blockfrost } }).then(r => r.json());

    const tasks = assets.slice(0, 40).map(async (a) => {
      const m = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/assets/${a.unit}`, { headers: { project_id: API_KEYS.blockfrost } }).then(r => r.json());
      const isNFT = parseInt(a.quantity) === 1;
      if ((mode==='tokens' && isNFT) || (mode==='nfts' && !isNFT)) return null;
      const price = getPrice(m.metadata?.ticker || 'ADA');
      const bal = parseInt(a.quantity) / Math.pow(10, m.metadata?.decimals || 0);
      return {
        id: a.unit, name: m.onchain_metadata?.name || m.asset_name, chain: 'cardano',
        image: m.onchain_metadata?.image ? `https://ipfs.io/ipfs/${m.onchain_metadata.image.replace('ipfs://', '')}` : '',
        balance: bal.toFixed(2), usdPrice: price.toFixed(2), totalValue: (bal * price).toFixed(2),
        symbol: m.metadata?.ticker || 'ADA', isToken: !isNFT
      };
    });
    const results = await Promise.all(tasks);
    res.json({ nfts: results.filter(n => n) });
  } catch (e) { res.json({ nfts: [] }); }
});

// Chain Loop for EVM
const evmChains = [{ id: 'ethereum', net: 'eth-mainnet' }, { id: 'abstract', net: 'abstract-mainnet' }, { id: 'monad', net: 'monad-testnet' }, { id: 'base', net: 'base-mainnet' }, { id: 'polygon', net: 'polygon-mainnet' }];
evmChains.forEach(c => {
  app.get(`/api/nfts/${c.id}/:address`, (req, res) => fetchAlchemyNFTs(c.net, req.params.address, c.id).then(n => res.json({ nfts: n })));
  app.get(`/api/tokens/${c.id}/:address`, (req, res) => fetchAlchemyTokens(c.net, req.params.address, c.id).then(t => res.json({ nfts: t })));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));