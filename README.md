# PoolBuy 🛒🔗

Group buying and volume discount escrow on-chain. Create deals, pool orders with your community, and automatically unlock volume discounts settled transparently through smart contracts.

---

## ⚡ Quick Start (Local Setup)

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/meetkothariii0/PoolBuy.git
cd PoolBuy
npm install
```

### 2. Start Local Hardhat Blockchain
In Terminal 1:
```bash
npx hardhat node
```
> The local node will run on `http://127.0.0.1:8545` with Chain ID `31354`.

### 3. Deploy the Smart Contract
In Terminal 2:
```bash
npx hardhat run scripts/deploy.ts --network localhost
```
> The deploy script automatically compiles `PoolBuy.sol` and syncs the deployed contract address directly into `frontend/app.js`.

### 4. Start Frontend Web Server
In Terminal 3 (or same terminal):
```bash
node scripts/serve-frontend.cjs
```
> Open your browser at **[http://127.0.0.1:3000](http://127.0.0.1:3000)**.

---

## 🦊 MetaMask Configuration

1. In MetaMask, open **Add Network** → **Add a network manually**:
   - **Network Name:** `Hardhat Local`
   - **New RPC URL:** `http://127.0.0.1:8545`
   - **Chain ID:** `31354`
   - **Currency Symbol:** `ETH`
2. **Import Pre-Funded Accounts:**
   - **Organizer (Account #0):** `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`
   - **Supplier (Account #1):** `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d`
   - **Buyer (Account #2):** `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a`

---

## 🧪 Testing

Run contract unit tests with:
```bash
npx hardhat test
```

---

## 📂 Project Architecture

- `contracts/PoolBuy.sol`: Core group-buying escrow smart contract with volume tiers and delivery dispute handling.
- `frontend/`: Lightweight web application (`index.html`, `styles.css`, `app.js`) with responsive ethers.js integration.
- `scripts/deploy.ts`: Automated deployment script with frontend address synchronization.
- `scripts/serve-frontend.cjs`: Local zero-dependency static HTTP server.
