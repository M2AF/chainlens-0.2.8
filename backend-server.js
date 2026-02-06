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
  helius: process.env.HELIUS_KEY
};

// --- EVM Helper ---
const fetchAlchemy = async (network, address, chainId) => {
  try {
    const res = await fetch(`https://${network}.g.alchemy.com/nft/v3/${API_KEYS.alchemy}/getNFTsForOwner?owner=${address}&withMetadata=true`);
    const data = await res.json();
    return (data.ownedNfts || []).map(nft => ({
      id: `${chainId}-${nft.contract.address}-${nft.tokenId}`,
      name: nft.name || nft.title || 'Unnamed NFT',
      image: nft.image?.cachedUrl || nft.image?.thumbnailUrl || nft.image?.originalUrl || '',
      collection: nft.contract.name || 'Collection',
      chain: chainId,
      metadata: { traits: nft.raw?.metadata?.attributes || [], description: nft.description || '' }
    }));
  } catch (e) { return []; }
};

// --- API ROUTES ---
app.get('/api/nfts/ethereum/:address', (req, res) => fetchAlchemy('eth-mainnet', req.params.address, 'ethereum').then(n => res.json({ nfts: n })));
app.get('/api/nfts/abstract/:address', (req, res) => fetchAlchemy('abstract-mainnet', req.params.address, 'abstract').then(n => res.json({ nfts: n })));
app.get('/api/nfts/monad/:address', (req, res) => fetchAlchemy('monad-testnet', req.params.address, 'monad').then(n => res.json({ nfts: n })));

// Solana Route
app.get('/api/nfts/solana/:address', async (req, res) => {
  try {
    const url = `https://mainnet.helius-rpc.com/?api-key=${API_KEYS.helius}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'my-id',
        method: 'getAssetsByOwner',
        params: { ownerAddress: req.params.address, page: 1, limit: 100, displayOptions: { showCollectionMetadata: true } }
      })
    });
    const data = await response.json();
    const items = data.result?.items || [];
    const nfts = items.map(asset => ({
      id: asset.id,
      name: asset.content?.metadata?.name || 'Solana NFT',
      chain: 'solana',
      image: asset.content?.links?.image || '',
      collection: asset.grouping?.[0]?.collection_metadata?.name || 'Solana',
      metadata: { traits: asset.content?.metadata?.attributes || [], description: asset.content?.metadata?.description || '' }
    }));
    res.json({ nfts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cardano Route + Handle Integration
app.get('/api/nfts/cardano/:address', async (req, res) => {
  try {
    let targetAddress = req.params.address;

    // --- Resolve ADA Handle ---
    if (targetAddress.startsWith('$')) {
      const handleName = targetAddress.replace('$', '').toLowerCase();
      try {
        const handleRes = await fetch(`https://api.handle.me/handles/${handleName}`);
        if (handleRes.ok) {
          const handleData = await handleRes.json();
          if (handleData.resolved_addresses?.ada) {
            targetAddress = handleData.resolved_addresses.ada;
          }
        }
      } catch (e) { console.error("Handle resolution error"); }
    }

    // --- Get Stake Address ---
    const stakeRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/addresses/${targetAddress}`, { headers: { project_id: API_KEYS.blockfrost } });
    const stakeData = await stakeRes.json();
    const stakeAddress = stakeData.stake_address;
    if (!stakeAddress) return res.json({ nfts: [] });

    // --- Get Assets ---
    const assetsRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/accounts/${stakeAddress}/addresses/assets`, { headers: { project_id: API_KEYS.blockfrost } });
    const assets = await assetsRes.json();

    const nftTasks = assets.filter(a => parseInt(a.quantity) === 1).slice(0, 50).map(async (asset) => {
      try {
        const metaRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/assets/${asset.unit}`, { headers: { project_id: API_KEYS.blockfrost } });
        const meta = await metaRes.json();
        let img = meta.onchain_metadata?.image || '';
        if (Array.isArray(img)) img = img.join('');
        let imageUrl = '';
        if (img) {
          if (img.startsWith('ipfs://')) imageUrl = `https://ipfs.io/ipfs/${img.replace('ipfs://', '')}`;
          else if (img.startsWith('Qm') || img.startsWith('baf')) imageUrl = `https://ipfs.io/ipfs/${img}`;
          else imageUrl = img.startsWith('http') ? img : `https://ipfs.io/ipfs/${img}`;
        }
        return {
          id: asset.unit,
          name: meta.onchain_metadata?.name || meta.asset_name || 'Cardano NFT',
          chain: 'cardano',
          image: imageUrl || 'https://via.placeholder.com/400/06b6d4/ffffff?text=Cardano+NFT',
          collection: meta.onchain_metadata?.collection || meta.policy_id?.substring(0, 8) || 'Cardano',
          metadata: { traits: meta.onchain_metadata?.attributes || [], description: meta.onchain_metadata?.description || '' }
        };
      } catch (err) { return null; }
    });

    const results = await Promise.all(nftTasks);
    res.json({ nfts: results.filter(n => n !== null) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));