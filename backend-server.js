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
  helius: process.env.HELIUS_KEY,
  unstoppable: process.env.UNSTOPPABLE_KEY
};

// --- Unstoppable Domains Resolution (EXISTING) ---
app.get('/api/resolve/unstoppable/:domain', async (req, res) => {
  const { domain } = req.params;
  try {
    const response = await fetch(`https://api.unstoppabledomains.com/resolve/domains/${domain}`, {
      headers: { 
        'Authorization': `Bearer ${API_KEYS.unstoppable}`,
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) return res.status(404).json({ error: 'Domain not found.' });
    
    const data = await response.json();
    const address = data.records?.['crypto.ETH.address'] || data.meta?.owner;
    
    if (address) res.json({ address });
    else res.status(404).json({ error: 'No EVM address linked.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Alchemy NFT Helper (EXISTING) ---
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
      isToken: false, // Flag for UI
      metadata: { traits: nft.raw?.metadata?.attributes || [], description: nft.description || '' }
    }));
  } catch (e) { return []; }
};

// --- NEW: Alchemy Token Helper (FOR TOKEN MODE) ---
const fetchAlchemyTokens = async (network, address, chainId) => {
  try {
    const res = await fetch(`https://${network}.g.alchemy.com/v2/${API_KEYS.alchemy}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "alchemy_getTokenBalances",
        params: [address]
      })
    });
    const data = await res.json();
    const balances = data.result?.tokenBalances || [];

    // Filter out zero balances early to save API calls
    const nonZeroBalances = balances.filter(t => {
      const raw = parseInt(t.tokenBalance, 16);
      return !isNaN(raw) && raw > 0;
    });

    const tokenTasks = nonZeroBalances.map(async (token) => {
      try {
        const metaRes = await fetch(`https://${network}.g.alchemy.com/v2/${API_KEYS.alchemy}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "alchemy_getTokenMetadata",
            params: [token.contractAddress]
          })
        });
        const meta = await metaRes.json();
        const metadata = meta.result;
        
        const rawBalance = parseInt(token.tokenBalance, 16);
        const decimals = metadata.decimals || 18;
        const balance = rawBalance / Math.pow(10, decimals);

        // Filter dust
        if (balance < 0.000001) return null;

        return {
          id: token.contractAddress,
          name: metadata.name || 'Unknown Token',
          symbol: metadata.symbol || '???',
          balance: balance.toLocaleString(undefined, { maximumFractionDigits: 4 }),
          image: metadata.logo || `https://via.placeholder.com/400/334155/ffffff?text=${metadata.symbol || '$'}`,
          chain: chainId,
          isToken: true // Flag for UI
        };
      } catch (e) { return null; }
    });

    const results = await Promise.all(tokenTasks);
    return results.filter(t => t !== null);
  } catch (e) { return []; }
};

// --- DYNAMIC EVM ROUTES (Covers Ethereum, Polygon, Base, Abstract, Monad) ---
const chains = [
  { name: 'ethereum', network: 'eth-mainnet' },
  { name: 'abstract', network: 'abstract-mainnet' },
  { name: 'monad', network: 'monad-testnet' },
  { name: 'base', network: 'base-mainnet' },
  { name: 'polygon', network: 'polygon-mainnet' }
];

chains.forEach(chain => {
  // Existing NFT Route
  app.get(`/api/nfts/${chain.name}/:address`, (req, res) => 
    fetchAlchemyNFTs(chain.network, req.params.address, chain.name).then(n => res.json({ nfts: n }))
  );
  // NEW Token Route
  app.get(`/api/tokens/${chain.name}/:address`, (req, res) => 
    fetchAlchemyTokens(chain.network, req.params.address, chain.name).then(t => res.json({ nfts: t }))
  );
});

// --- SOLANA ROUTES (Dual Mode) ---
app.get('/api/:mode(nfts|tokens)/solana/:address', async (req, res) => {
  const { mode, address } = req.params;
  try {
    // If Token Mode, use getTokenAccounts; if NFT Mode, use getAssetsByOwner
    const method = mode === 'tokens' ? 'getTokenAccounts' : 'getAssetsByOwner';
    const params = mode === 'tokens' 
      ? { ownerAddress: address, page: 1, limit: 100 }
      : { ownerAddress: address, page: 1, limit: 100, displayOptions: { showCollectionMetadata: true } };

    const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${API_KEYS.helius}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'sol-req', method, params })
    });
    const data = await response.json();

    if (mode === 'tokens') {
      const tokens = (data.result?.token_accounts || []).map(t => ({
        id: t.mint,
        name: 'Solana Token',
        symbol: 'SOL', // Basic SPL handling
        balance: (t.amount / Math.pow(10, t.decimals)).toFixed(4),
        image: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
        chain: 'solana',
        isToken: true
      }));
      return res.json({ nfts: tokens.filter(t => parseFloat(t.balance) > 0) });
    } else {
      const nfts = (data.result?.items || []).map(asset => ({
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

// --- CARDANO ROUTE (Preserved Existing Logic) ---
app.get('/api/nfts/cardano/:address', async (req, res) => {
  try {
    let targetAddress = req.params.address;
    if (targetAddress.startsWith('$')) {
      const handleName = targetAddress.replace('$', '').toLowerCase();
      const handleRes = await fetch(`https://api.handle.me/handles/${handleName}`);
      if (handleRes.ok) {
        const handleData = await handleRes.json();
        if (handleData.resolved_addresses?.ada) targetAddress = handleData.resolved_addresses.ada;
      }
    }

    const stakeRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/addresses/${targetAddress}`, { headers: { project_id: API_KEYS.blockfrost } });
    const stakeData = await stakeRes.json();
    const stakeAddress = stakeData.stake_address;
    if (!stakeAddress) return res.json({ nfts: [] });

    const assetsRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/accounts/${stakeAddress}/addresses/assets`, { headers: { project_id: API_KEYS.blockfrost } });
    const assets = await assetsRes.json();

    const nftTasks = assets.filter(a => parseInt(a.quantity) === 1).slice(0, 50).map(async (asset) => {
      try {
        const metaRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/assets/${asset.unit}`, { headers: { project_id: API_KEYS.blockfrost } });
        const meta = await metaRes.json();
        let img = meta.onchain_metadata?.image || '';
        if (Array.isArray(img)) img = img.join('');
        let imageUrl = img ? (img.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${img.replace('ipfs://', '')}` : (img.startsWith('http') ? img : `https://ipfs.io/ipfs/${img}`)) : '';
        
        return {
          id: asset.unit,
          name: meta.onchain_metadata?.name || meta.asset_name || 'Cardano NFT',
          chain: 'cardano',
          image: imageUrl || 'https://via.placeholder.com/400/06b6d4/ffffff?text=Cardano+NFT',
          collection: meta.onchain_metadata?.collection || meta.policy_id?.substring(0, 8) || 'Cardano',
          isToken: false,
          metadata: { traits: meta.onchain_metadata?.attributes || [], description: meta.onchain_metadata?.description || '' }
        };
      } catch (err) { return null; }
    });

    const results = await Promise.all(nftTasks);
    res.json({ nfts: results.filter(n => n !== null) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// FIX: Bind to 0.0.0.0 to fix "No open ports detected"
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));