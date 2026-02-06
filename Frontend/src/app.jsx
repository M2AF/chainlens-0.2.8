import React, { useState } from 'react';

// --- CONFIGURATION ---
// When you deploy to Render, change this to your Render URL
const API_BASE = "http://localhost:3001/api"; 

function App() {
  const [address, setAddress] = useState('');
  const [chain, setChain] = useState('ethereum');
  const [nfts, setNfts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedNft, setSelectedNft] = useState(null);

  const scanNFTs = async () => {
    if (!address) return alert("Please enter a wallet address");
    setLoading(true);
    setNfts([]);

    try {
      const response = await fetch(`${API_BASE}/nfts/${chain}/${address}`);
      const data = await response.json();
      setNfts(data.nfts || []);
    } catch (err) {
      console.error("Scan failed:", err);
      alert("Error scanning wallet. Check if backend is running.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-container">
      <header>
        <h1>ChainLens <span className="badge">Multichain</span></h1>
        <div className="search-bar">
          <select value={chain} onChange={(e) => setChain(e.target.value)}>
            <option value="ethereum">Ethereum</option>
            <option value="cardano">Cardano</option>
            <option value="solana">Solana</option>
            <option value="abstract">Abstract (Testnet)</option>
            <option value="monad">Monad (Testnet)</option>
          </select>
          <input 
            type="text" 
            placeholder={`Enter ${chain} address...`}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          <button onClick={scanNFTs} disabled={loading}>
            {loading ? 'Scanning...' : 'Scan Assets'}
          </button>
        </div>
      </header>

      <main className="nft-grid">
        {nfts.map((nft) => (
          <div key={nft.id} className="nft-card" onClick={() => setSelectedNft(nft)}>
            <div className="nft-image-container">
              <img src={nft.image} alt={nft.name} onError={(e) => e.target.src = 'https://via.placeholder.com/400?text=No+Image'} />
            </div>
            <div className="nft-info">
              <h3>{nft.name}</h3>
              <p>{nft.collection}</p>
              <span className={`chain-tag ${nft.chain}`}>{nft.chain}</span>
            </div>
          </div>
        ))}
      </main>

      {/* Modal for NFT Details */}
      {selectedNft && (
        <div className="modal-overlay" onClick={() => setSelectedNft(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <img src={selectedNft.image} alt={selectedNft.name} />
            <h2>{selectedNft.name}</h2>
            <p className="description">{selectedNft.metadata.description || "No description provided."}</p>
            <div className="traits">
              {selectedNft.metadata.traits?.map((t, i) => (
                <div key={i} className="trait">
                  <span>{t.trait_type || t.key}:</span> {t.value}
                </div>
              ))}
            </div>
            <button className="close-btn" onClick={() => setSelectedNft(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;