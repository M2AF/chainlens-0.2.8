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
    // Standardize to NFT API v3 for all chains, including Abstract and Monad
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
    console.error(`Error fetching NFTs for ${chainId}:`, e);
    return []; 
  }
};

// --- EVM Token Helper (Native + ERC20) ---
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
    } else if (chainId === 'abstract') {
      nativeSymbol = 'ABS'; nativeName = 'Abstract'; nativeLogo = 'https://cryptologos.cc/logos/abstract-abs-logo.png';
      nativePriceAddr = '0x0000000000000000000000000000000000000000'; // Native
    }

    const nativeUsdPrice = await fetchUSDPrice(chainId, nativePriceAddr);

    if (nativeRes.result) {
      const rawNative = parseInt(nativeRes.result, 16);
      const nativeBalance = rawNative / 1e18;
      if (nativeBalance > 0) {
        tokens.push({
          id: 'native',
          name: nativeName,
          symbol: nativeSymbol,
          balance: nativeBalance.toFixed(4),
          usdPrice: nativeUsdPrice,
          nativePrice: "1.0000",
          totalValue: (nativeBalance * nativeUsdPrice).toFixed(2),
          image: nativeLogo,
          chain: chainId,
          isToken: true
        });
      }
    }

    const balances = erc20Res.result?.tokenBalances || [];
    const nonZero = balances.filter(t => parseInt(t.tokenBalance, 16) > 0).slice(0, 15);

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

        const usdPrice = await fetchUSDPrice(chainId, token.contractAddress);
        const nativePrice = nativeUsdPrice > 0 ? (usdPrice / nativeUsdPrice).toFixed(6) : "0.0000";

        return {
          id: token.contractAddress,
          name: metadata.name || 'Unknown',
          symbol: metadata.symbol || '???',
          balance: balance.toFixed(4),
          usdPrice: usdPrice,
          nativePrice: nativePrice,
          totalValue: (balance * usdPrice).toFixed(2),
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

// --- Routes ---
const evmChains = [
  { id: 'ethereum', net: 'eth-mainnet' },
  { id: 'abstract', net: 'abstract-mainnet' },
  { id: 'monad', net: 'monad-testnet' },
  { id: 'base', net: 'base-mainnet' },
  { id: 'polygon', net: 'polygon-mainnet' }
];

evmChains.forEach(chain => {
  app.get(`/api/nfts/${chain.id}/:address`, (req, res) => fetchAlchemyNFTs(chain.net, req.params.address, chain.id).then(n => res.json({ nfts: n })));
  app.get(`/api/tokens/${chain.id}/:address`, (req, res) => fetchAlchemyTokens(chain.net, req.params.address, chain.id).then(t => res.json({ nfts: t })));
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
        params: { 
          ownerAddress: address, 
          page: 1, 
          limit: 100, 
          options: { 
            showFungible: mode === 'tokens', 
            showNativeBalance: mode === 'tokens' 
          } 
        }
      })
    });
    const data = await response.json();
    const items = data.result?.items || [];

    if (mode === 'tokens') {
      const tokens = items.filter(i => i.interface === 'FungibleToken' || i.interface === 'FungibleAsset').map(t => {
        const balanceNum = (t.token_info?.balance / Math.pow(10, t.token_info?.decimals || 0));
        const usdPrice = t.token_info?.price_info?.price_per_token || 0;
        const nativePrice = solPrice > 0 ? (usdPrice / solPrice).toFixed(6) : "0.0000";
        
        return {
          id: t.id,
          name: t.content?.metadata?.name || 'Solana Token',
          symbol: t.content?.metadata?.symbol || 'SOL',
          balance: balanceNum.toFixed(4),
          usdPrice: usdPrice,
          nativePrice: nativePrice,
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
app.get('/api/:mode(nfts|tokens)/cardano/:address', async (req, res) => {
  const { mode, address } = req.params;
  try {
    const adaPrice = await fetchUSDPrice('cardano', 'cardano');
    let target = address;

    const addrRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/addresses/${target}`, { headers: { project_id: API_KEYS.blockfrost } });
    
    if (addrRes.status === 404) return res.json({ nfts: [] });
    
    const addrData = await addrRes.json();
    if (!addrData.stake_address) return res.json({ nfts: [] });

    const assetsRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/accounts/${addrData.stake_address}/addresses/assets`, { headers: { project_id: API_KEYS.blockfrost } });
    const assets = await assetsRes.json();

    const tasks = assets.slice(0, 30).map(async (a) => {
      const metaRes = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/assets/${a.unit}`, { headers: { project_id: API_KEYS.blockfrost } });
      const meta = await metaRes.json();
      const isNFT = parseInt(a.quantity) === 1;
      
      if (mode === 'tokens' && isNFT) return null;
      if (mode === 'nfts' && !isNFT) return null;

      const usdPrice = await fetchUSDPrice('cardano', a.unit);
      const balance = (parseInt(a.quantity) / Math.pow(10, meta.metadata?.decimals || 0));
      const nativePrice = adaPrice > 0 ? (usdPrice / adaPrice).toFixed(6) : "0.0000";

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
        nativePrice: nativePrice,
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

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));