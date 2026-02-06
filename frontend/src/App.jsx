import React, { useState } from 'react';
import './App.css';

function App() {
  // 1. State variables to replace manual DOM values
  const [address, setAddress] = useState('');
  const [chain, setChain] = useState('cardano'); // Default selection
  const [nfts, setNfts] = useState([]);
  const [loading, setLoading] = useState(false);

  // 2. The reimplemented fetch function
  const scanNFTs = async () => {
    if (!address) return alert("Please enter an address");
    
    setLoading(true);
    try {
      // Uses the environment variable you set in .env
      const API_BASE = import.meta.env.VITE_API_BASE;
      const response = await fetch(`${API_BASE}/nfts/${chain}/${address}`);
      const data = await response.json();
      
      // Update the state, which automatically rerenders the UI
      setNfts(data.nfts || []);
    } catch (err) {
      console.error("Scan failed:", err);
      alert("Error reaching the backend.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-container">
      {/* Imitating your original UI structure */}
      <header>
        <h1>ChainLens</h1>
        <div className="search-section">
          <select value={chain} onChange={(e) => setChain(e.target.value)}>
            <option value="cardano">Cardano</option>
            <option value="ethereum">Ethereum</option>
            <option value="solana">Solana</option>
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

      {/* 3. Logic to display the results (replaces manual innerHTML) */}
      <main className="nft-grid">
        {nfts.map((nft) => (
          <div key={nft.id} className="nft-card">
            <img src={nft.image} alt={nft.name} />
            <div className="nft-details">
              <h3>{nft.name}</h3>
              <p>{nft.collection}</p>
            </div>
          </div>
        ))}
        {nfts.length === 0 && !loading && <p>No assets found. Try another address.</p>}
      </main>
    </div>
  );
}

export default App;