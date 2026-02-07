require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
// FIX: Bind to process.env.PORT for Render, default to 10000
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

// --- EVM NFT Helper ---
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
      metadata: { traits: nft.raw?.metadata?.attributes || [], description: nft.description || '' }
    }));
  } catch (e) { return []; }
};

// --- EVM Token Helper (UPDATED: Native + ERC20) ---
const fetchAlchemyTokens = async (network, address, chainId) => {
  try {
    const baseUrl = `https://${network}.g.alchemy.com/v2/${API_KEYS.alchemy}`;
    
    // 1. Fetch Native Balance (ETH, MON, etc.)
    const nativeTask = fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [address, "latest"], id: 1 })
    }).then(r => r.json());

    // 2. Fetch ERC-20 Balances
    const erc20Task = fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: "2.0", method: "alchemy_getTokenBalances", params: [address], id: 2 })
    }).then(r => r.json());

    const [nativeRes, erc20Res] = await Promise.all([nativeTask, erc20Task]);

    const tokens = [];

    // Process Native Token
    if (nativeRes.result) {
      const rawNative = parseInt(nativeRes.result, 16);
      const nativeBalance = rawNative / 1e18; // 18 decimals standard
      
      if (nativeBalance > 0.0001) {
        // Assign correct symbols for Abstract/Monad
        let symbol = 'ETH'; 
        let name = 'Ether';
        if (chainId === 'monad') { symbol = 'MON'; name = 'Monad'; }
        if (chainId === 'abstract') { symbol = 'ETH'; name = 'Abstract ETH'; }
        if (chainId === 'polygon') { symbol = 'MATIC'; name = 'Polygon'; }

        tokens.push({
          id: 'native',
          name: name,
          symbol: symbol,
          balance: nativeBalance.toLocaleString(undefined, { maximumFractionDigits: 4 }),
          image: chainId === 'monad' 
            ? 'https://pbs.twimg.com/profile_images/1691568696803713024/Sw_hQ2yT_400x400.jpg' // Monad Logo
            : 'https://cryptologos.cc/logos/ethereum-eth-logo.png',
          chain: chainId,
          isToken: true
        });
      }
    }

    // Process ERC-20s
    const balances = erc20Res.result?.tokenBalances || [];
    const nonZero = balances.filter(t => parseInt(t.tokenBalance, 16) > 0);

    const erc20Tasks = nonZero.map(async (token) => {
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

        return {
          id: token.contractAddress,
          name: metadata.name || 'Unknown',
          symbol: metadata.symbol || '???',
          balance: balance.toLocaleString(undefined, { maximumFractionDigits: 4 }),
          image: metadata.logo || `https://via.placeholder.com/400/334155/ffffff?text=${metadata.symbol || '$'}`,
          chain: chainId,
          isToken: true
        };
      } catch (e) { return null; }
    });

    const erc20Results = await Promise.all(erc20Tasks);
    return [...tokens, ...erc20Results.filter(t => t !== null)];

  } catch (e) { return []; }
};

// --- Routes Setup ---
const evmChains = [
  { id: 'ethereum', net: 'eth-mainnet' },
  { id: 'abstract', net: 'abstract-mainnet' }, // Check Alchemy dashboard if 'abstract-testnet' is needed instead
  { id: 'monad', net: 'monad-testnet' },       // Monad is Testnet currently
  { id: 'base', net: 'base-mainnet' },
  { id: 'polygon', net: 'polygon-mainnet' }
];

evmChains.forEach(chain => {
  app.get(`/api/nfts/${chain.id}/:address`, (req, res) => fetchAlchemyNFTs(chain.net, req.params.address, chain.id).then(n => res.json({ nfts: n })));
  app.get(`/api/tokens/${chain.id}/:address`, (req, res) => fetchAlchemyTokens(chain.net, req.params.address, chain.id).then(t => res.json({ nfts: t })));
});

// --- Solana (Helius DAS) ---
app.get('/api/:mode(nfts|tokens)/solana/:address', async (req, res) => {
  const { mode, address } = req.params;
  try {
    const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${API_KEYS.helius}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'sol-scan', method: 'getAssetsByOwner',
        params: { 
          ownerAddress: address, page: 1, limit: 100, 
          displayOptions: { showFungible: mode === 'tokens', showNativeBalance: mode === 'tokens' } 
        }
      })
    });
    const data = await response.json();
    const items = data.result?.items || [];

    if (mode === 'tokens') {
      // Helius returns Native SOL as a "FungibleAsset" automatically
      const tokens = items.filter(i => i.interface === 'FungibleToken' || i.interface === 'FungibleAsset').map(t => ({
        id: t.id,
        name: t.content?.metadata?.name || 'Solana Token',
        symbol: t.content?.metadata?.symbol || 'SOL',
        balance: (t.token_info?.balance / Math.pow(10, t.token_info?.decimals || 0)).toFixed(4),
        image: t.content?.links?.image || 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
        chain: 'solana',
        isToken: true
      }));
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

// --- Cardano (Blockfrost) ---
app.get('/api/:mode(nfts|tokens)/cardano/:address', async (req, res) => {
  const { mode, address } = req.params;
  try {
    let target = address;
    if (target.startsWith('$')) {
      const hRes = await fetch(`https://api.handle.me/handles/${target.replace('$', '').toLowerCase()}`);
      if (hRes.ok) {
        const hData = await hRes.json();
        if (hData.resolved_addresses?.ada) target = hData.resolved_addresses.ada;
      }
    }
    const addrRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/addresses/${target}`, { headers: { project_id: API_KEYS.blockfrost } });
    const addrData = await addrRes.json();
    if (!addrData.stake_address) return res.json({ nfts: [] });

    const assetsRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/accounts/${addrData.stake_address}/addresses/assets`, { headers: { project_id: API_KEYS.blockfrost } });
    const assets = await assetsRes.json();

    const tasks = assets.slice(0, 50).map(async (a) => {
      const metaRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/assets/${a.unit}`, { headers: { project_id: API_KEYS.blockfrost } });
      const meta = await metaRes.json();
      const isNFT = parseInt(a.quantity) === 1;
      
      if (mode === 'tokens' && isNFT) return null;
      if (mode === 'nfts' && !isNFT) return null;

      let img = meta.onchain_metadata?.image || '';
      if (Array.isArray(img)) img = img.join('');
      const imageUrl = img ? (img.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${img.replace('ipfs://', '')}` : (img.startsWith('http') ? img : `https://ipfs.io/ipfs/${img}`)) : '';

      return {
        id: a.unit,
        name: meta.onchain_metadata?.name || meta.asset_name || 'Cardano Asset',
        chain: 'cardano',
        image: imageUrl || 'https://via.placeholder.com/400/0033AD/ffffff?text=ADA',
        balance: mode === 'tokens' ? (parseInt(a.quantity) / Math.pow(10, meta.metadata?.decimals || 0)).toFixed(2) : null,
        symbol: meta.metadata?.ticker || '',
        isToken: mode === 'tokens',
        metadata: { traits: meta.onchain_metadata?.attributes || [], description: meta.onchain_metadata?.description || '' }
      };
    });
    const results = await Promise.all(tasks);
    res.json({ nfts: results.filter(n => n !== null) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));