# NFT Viewer Backend Setup

This backend server proxies API calls to Alchemy and Blockfrost to avoid CORS issues.

## Setup Instructions

### 1. Install Node.js
Make sure you have Node.js installed (v14 or higher)
- Download from: https://nodejs.org/

### 2. Install Dependencies
```bash
npm install
```

### 3. Start the Server
```bash
npm start
```

The server will run on `http://localhost:3001`

For development with auto-reload:
```bash
npm run dev
```

## API Endpoints

- `GET /api/nfts/ethereum/:address` - Fetch Ethereum NFTs
- `GET /api/nfts/cardano/:address` - Fetch Cardano NFTs
- `GET /api/nfts/abstract/:address` - Fetch Abstract NFTs
- `GET /api/nfts/monad/:address` - Fetch Monad NFTs
- `GET /api/health` - Health check

## Testing

Test with curl:
```bash
# Health check
curl http://localhost:3001/api/health

# Fetch Ethereum NFTs (returns 3 NFTs, spam filtered)
curl http://localhost:3001/api/nfts/ethereum/0x01faF6DFc230d755141D84d7cB980dd68f5Efe13
```

## Test Addresses

### Ethereum
```
0x01faF6DFc230d755141D84d7cB980dd68f5Efe13
```
Returns 3 legitimate NFTs (spam filtered out)

### Cardano
```
addr1qxy90l0p5xh0sh8y2dqzxvdv8lqfn45lqwx3a9j3c79u3e8x8m3h2c6a0qmfmrhmm29sgtqzcr3avrvy25hxdq56r6esw2gcjn
```
Note: Use addresses starting with `addr1` (payment) or `stake1` (stake)

### Abstract
Use the same Ethereum address format:
```
0x01faF6DFc230d755141D84d7cB980dd68f5Efe13
```

### Monad
⚠️ **Monad mainnet may not be live yet** - endpoint returns empty array if unavailable

## Troubleshooting

### Cardano Returns Empty Array
- Cardano addresses must start with `addr1` or `stake1`
- The Ethereum test address won't work for Cardano
- Try the Cardano address above
- Check that your Blockfrost API key is valid

### Monad Returns Empty Array
- Monad mainnet may not be launched yet
- The Alchemy endpoint might not support Monad
- This is expected behavior - the endpoint gracefully returns empty

### CORS Errors
- Make sure backend is running on port 3001
- Check that frontend is calling http://localhost:3001
- CORS is enabled for all origins in the backend

### "Failed to fetch" in Frontend
- Backend server is not running - run `npm start`
- Wrong port - check BACKEND_URL in frontend code
- Firewall blocking localhost:3001

## Deployment Options

### Option 1: Deploy to Vercel
1. Install Vercel CLI: `npm i -g vercel`
2. Run: `vercel`
3. Follow prompts

### Option 2: Deploy to Railway
1. Go to railway.app
2. Create new project
3. Connect your GitHub repo
4. Deploy automatically

### Option 3: Deploy to Heroku
1. Install Heroku CLI
2. Run: `heroku create`
3. Run: `git push heroku main`

## Security Notes

- API keys are embedded in the backend code
- Keep your backend repository private
- Consider using environment variables for production
- Add rate limiting for production use

## Environment Variables (Optional)

Create a `.env` file:
```
ALCHEMY_API_KEY=e31L3F5hG_qzakP1mbMau
BLOCKFROST_PROJECT_ID=mainnetggpKuFZ9qVnjIk6kW3MpMpYtI3BLB3ay
PORT=3001
```

Then update the code to use `process.env.ALCHEMY_API_KEY` instead of hardcoded values.
