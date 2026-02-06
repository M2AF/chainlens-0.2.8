require('dotenv').config(); // Securely load keys from .env
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// API keys pulled from your .env file
const API_KEYS = {
  alchemy: process.env.ALCHEMY_KEY,
  blockfrost: process.env.BLOCKFROST_KEY,
  helius: process.env.HELIUS_KEY
};

// --- EVM Helper (Ethereum, Abstract, Monad) ---
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
  } catch (e) { 
    return []; 
  }
};

app.get('/api/nfts/ethereum/:address', (req, res) => fetchAlchemy('eth-mainnet', req.params.address, 'ethereum').then(n => res.json({ nfts: n })));
app.get('/api/nfts/abstract/:address', (req, res) => fetchAlchemy('abstract-mainnet', req.params.address, 'abstract').then(n => res.json({ nfts: n })));
app.get('/api/nfts/monad/:address', (req, res) => fetchAlchemy('monad-testnet', req.params.address, 'monad').then(n => res.json({ nfts: n })));

// --- Solana (Helius) ---
app.get('/api/nfts/solana/:address', async (req, res) => {
  try {
    const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${API_KEYS.helius}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'helius', method: 'getAssetsByOwner',
        params: { ownerAddress: req.params.address, page: 1, limit: 50 }
      }),
    });
    const { result } = await response.json();
    res.json({ nfts: (result.items || []).map(a => ({
      id: a.id, name: a.content?.metadata?.name || 'Solana NFT',
      image: a.content?.links?.image || '', collection: 'Solana', chain: 'solana',
      metadata: { traits: a.content?.metadata?.attributes || [], description: a.content?.metadata?.description || '' }
    }))});
  } catch (e) { res.json({ nfts: [] }); }
});

// --- Cardano (Blockfrost) - RESTORED & SECURED ---
app.get('/api/nfts/cardano/:address', async (req, res) => {
  const address = req.params.address;
  console.log(`\n🔍 Cardano NFT Request for: ${address}`);
  
  try {
    const addressUrl = `https://cardano-mainnet.blockfrost.io/api/v0/addresses/${address}`;
    const addressRes = await fetch(addressUrl, {
      headers: { 'project_id': API_KEYS.blockfrost }
    });
    
    if (!addressRes.ok) return res.json({ nfts: [] });
    
    const addressData = await addressRes.json();
    const allAssets = addressData.amount || [];
    
    // Filter out ADA (lovelace) and keep potential NFTs (quantity 1)
    const potentialNFTs = allAssets.filter(asset => asset.unit !== 'lovelace' && (asset.quantity === "1" || asset.quantity === 1));
    
    // Limit to 40 for performance
    const nftsToFetch = potentialNFTs.slice(0, 40);
    
    const nftPromises = nftsToFetch.map(async (asset, index) => {
      try {
        const metaRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/assets/${asset.unit}`, {
          headers: { 'project_id': API_KEYS.blockfrost }
        });
        const meta = await metaRes.json();
        
        let img = meta.onchain_metadata?.image || '';
        if (Array.isArray(img)) img = img.join('');
        
        let imageUrl = '';
        if (img) {
          if (img.startsWith('ipfs://')) imageUrl = `https://ipfs.io/ipfs/${img.replace('ipfs://', '')}`;
          else if (img.startsWith('ipfs/')) imageUrl = `https://ipfs.io/ipfs/${img.replace('ipfs/', '')}`;
          else if (img.startsWith('Qm') || img.startsWith('baf')) imageUrl = `https://ipfs.io/ipfs/${img}`;
          else imageUrl = img.startsWith('http') ? img : `https://ipfs.io/ipfs/${img}`;
        }
        
        return {
          id: asset.unit,
          name: meta.onchain_metadata?.name || meta.asset_name || 'Cardano NFT',
          chain: 'cardano',
          image: imageUrl || 'https://via.placeholder.com/400/06b6d4/ffffff?text=Cardano+NFT',
          collection: meta.onchain_metadata?.collection || meta.policy_id?.substring(0, 8) || 'Cardano',
          metadata: { 
            traits: meta.onchain_metadata?.attributes || [], 
            description: meta.onchain_metadata?.description || '' 
          }
        };
      } catch (err) { return null; }
    });
    
    const nfts = (await Promise.all(nftPromises)).filter(n => n !== null);
    res.json({ nfts });
  } catch (e) { 
    res.json({ nfts: [] }); 
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));