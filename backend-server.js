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

// --- EVM Token Helper (New Addition) ---
const fetchAlchemyTokens = async (network, address, chainId) => {
  try {
    const res = await fetch(`https://${network}.g.alchemy.com/data/v1/${API_KEYS.alchemy}/tokens/by-address`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        addresses: [{ address, network: network.replace('-mainnet', '') }],
        withPrices: true 
      })
    });
    const data = await res.json();
    const tokens = data.data?.[0]?.tokens || [];
    return tokens.map(t => ({
      id: `${chainId}-${t.tokenAddress || 'native'}`,
      name: t.tokenMetadata?.name || 'Unknown Token',
      symbol: t.tokenMetadata?.symbol || '',
      logo: t.tokenMetadata?.logo || '',
      balance: parseFloat(t.tokenBalance) / Math.pow(10, t.tokenMetadata?.decimals || 18),
      priceUsd: parseFloat(t.tokenPrices?.[0]?.value || 0),
      chain: chainId,
      type: 'token'
    })).filter(t => t.balance > 0);
  } catch (e) { return []; }
};

// --- API ROUTES ---
app.get('/api/nfts/:chain/:address', (req, res) => fetchAlchemy(`${req.params.chain}-mainnet`, req.params.address, req.params.chain).then(n => res.json({ nfts: n })));
app.get('/api/tokens/:chain/:address', (req, res) => fetchAlchemyTokens(`${req.params.chain}-mainnet`, req.params.address, req.params.chain).then(t => res.json({ tokens: t })));

// Solana Route (Supports both)
app.get('/api/:mode/solana/:address', async (req, res) => {
  const isToken = req.params.mode === 'tokens';
  try {
    const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${API_KEYS.helius}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'helius', method: 'searchAssets',
        params: { 
          ownerAddress: req.params.address, 
          tokenType: isToken ? 'fungible' : 'nonFungible',
          displayOptions: { showFungible: isToken, showCollectionMetadata: !isToken } 
        }
      })
    });
    const data = await response.json();
    const items = data.result?.items || [];
    const results = items.map(item => isToken ? ({
      id: item.id, name: item.content?.metadata?.name || 'Token', symbol: item.content?.metadata?.symbol,
      logo: item.content?.links?.image, balance: item.token_info?.balance / Math.pow(10, item.token_info?.decimals || 0),
      priceUsd: item.token_info?.price_info?.price_per_token || 0, chain: 'solana', type: 'token'
    }) : ({
      id: item.id, name: item.content?.metadata?.name || 'Solana NFT', chain: 'solana',
      image: item.content?.links?.image || '', collection: item.grouping?.[0]?.collection_metadata?.name || 'Solana',
      metadata: { traits: item.content?.metadata?.attributes || [], description: item.content?.metadata?.description || '' }
    }));
    res.json({ [isToken ? 'tokens' : 'nfts']: results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));