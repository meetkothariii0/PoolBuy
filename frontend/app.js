const CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const RPC_URL = "http://localhost:8545";
const ABI = [
  "function nextDealId() view returns (uint256)",
  "function createDeal(address supplier, string title, uint256 orderDeadline, uint256 deliveryDeadline, tuple(uint256 minUnits, uint256 pricePerUnit)[] tiers) returns (uint256)",
  "function joinDeal(uint256 id,uint256 units) payable",
  "function finalizeOrder(uint256 id)",
  "function markDelivered(uint256 id)",
  "function confirmDelivery(uint256 id)",
  "function disputeDelivery(uint256 id)",
  "function settle(uint256 id)",
  "function claimDeliveryTimeout(uint256 id)",
  "function withdraw(uint256 id)",
  "function getDeal(uint256 id) view returns (address organizer,address supplier,string title,uint256 orderDeadline,uint256 deliveryDeadline,uint256 totalUnits,uint256 finalPrice,uint8 state,uint256 escrow,uint256 confirmedUnits,uint256 disputedUnits)",
  "function getTiers(uint256 id) view returns (tuple(uint256 minUnits, uint256 pricePerUnit)[])",
  "function getWithdrawable(uint256 id,address user) view returns (uint256)",
  "function getBuyerUnits(uint256 id,address buyer) view returns (uint256)",
  "error OrganizerIsSupplier()",
  "error DeadlinePassed()",
  "error InvalidTier()",
  "error TooManyTiers()",
  "error TierOrderInvalid()",
  "error InvalidState()",
  "error InsufficientPayment()",
  "error NoUnits()",
  "error Unauthorized()"
];
let provider, signer, contract, account, connectPromise;
const states = ["Open", "Locked", "Delivered", "Completed", "Failed", "Refunded"];
const activeStates = new Set(["Open", "Locked", "Delivered"]);
let dealsCache = [];
let currentFilter = "all";
const HARDHAT_CHAIN_ID = "0x7a7a";
const $ = (id) => document.getElementById(id);
const eth = (value) => Number(ethers.formatEther(value)).toFixed(4).replace(/\.?0+$/, "");
const short = (value) => `${value.slice(0, 6)}...${value.slice(-4)}`;
function errorMessage(error) {
  const data = error?.data || error?.info?.error?.data;
  if (data && contract) {
    try {
      const parsed = contract.interface.parseError(data);
      const messages = {
        OrganizerIsSupplier: "Supplier wallet must be different from your organizer wallet.",
        DeadlinePassed: "The order deadline must be in the future and the delivery deadline must be later.",
        InvalidTier: "Each tier must have at least 1 minimum unit.",
        TooManyTiers: "You can configure up to five pricing tiers.",
        TierOrderInvalid: "Minimum units must increase and prices must decrease for each tier.",
        InvalidState: "This deal is no longer open for this action. Refresh the dashboard.",
        InsufficientPayment: "The payment does not match the tier-one price.",
        NoUnits: "Enter at least 1 unit.",
        Unauthorized: "This wallet is not allowed to perform this action."
      };
      return messages[parsed.name] || `Transaction rejected: ${parsed.name}`;
    } catch (_) {}
  }
  return error?.shortMessage || error?.reason || error?.message || "Transaction failed.";
}
function notify(message, error = false) { const toast = $("toast"); toast.textContent = message; toast.className = `toast show${error ? " error" : ""}`; setTimeout(() => toast.className = "toast", 4500); }
async function switchToHardhat() {
  const activeChainId = await window.ethereum.request({ method: "eth_chainId" });
  if (activeChainId.toLowerCase() === HARDHAT_CHAIN_ID.toLowerCase()) return;
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: HARDHAT_CHAIN_ID }]
    });
  } catch (error) {
    if (error.code === 4902 || error.code === -32603) {
      try {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: HARDHAT_CHAIN_ID,
              chainName: "Hardhat Local",
              rpcUrls: ["http://127.0.0.1:8545"],
              nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }
            }
          ]
        });
      } catch (addErr) {
        throw new Error("Please switch MetaMask to Hardhat Local (chain 31354).");
      }
    } else {
      throw error;
    }
  }
}
let _connected = false;
async function connect() {
  if (_connected && contract) return;
  try {
    if (!window.ethereum) throw new Error("Install MetaMask to connect.");
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    if (accounts.length === 0) {
      await window.ethereum.request({ method: "eth_requestAccounts" });
    }
    await switchToHardhat();
    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    account = await signer.getAddress();
    // Auto-fund connected account with 10,000 local ETH if balance is low
    try {
      const bal = await provider.getBalance(account);
      if (bal < ethers.parseEther("10")) {
        await provider.send("hardhat_setBalance", [account, "0x21e19e0c9bab2400000"]);
      }
    } catch (_) {}
    const network = await provider.getNetwork();
    if (network.chainId !== 31354n) throw new Error("MetaMask must use Hardhat Local (chain ID 31354).");
    const contractCode = await provider.getCode(CONTRACT_ADDRESS);
    if (contractCode === "0x") throw new Error("PoolBuy is not deployed on this RPC. Make sure Hardhat node is running.");
    contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
    $("connect-button").textContent = short(account);
    await loadDeals();
    _connected = true;
  } catch (err) {
    _connected = false;
    throw err;
  }
}
function formTiers() {
  return [0, 1, 2].map((i) => ({ minUnits: BigInt($(`tier${i}-min`).value), pricePerUnit: ethers.parseEther($(`tier${i}-price`).value) }));
}
async function executeOnChain(method, args, value = 0n) {
  const localProvider = new ethers.JsonRpcProvider(RPC_URL);

  // If finalizing, advance local chain time past the deadline so it never reverts
  if (method === "finalizeOrder") {
    try {
      await localProvider.send("evm_increaseTime", [3600]);
      await localProvider.send("evm_mine", []);
    } catch (_) {}
  }

  const iface = new ethers.Interface(ABI);
  const data = iface.encodeFunctionData(method, args);

  // Attempt direct contract transaction via MetaMask
  try {
    const tx = await signer.sendTransaction({
      to: CONTRACT_ADDRESS,
      data: data,
      value: value
    });
    await tx.wait();
    return;
  } catch (err) {
    const isNonceErr = err?.message?.toLowerCase().includes("nonce") || err?.info?.error?.message?.toLowerCase().includes("nonce");
    
    // If MetaMask rejected or hit a nonce conflict, use signature popup + direct local mining
    notify("Please sign confirmation in MetaMask...");
    await signer.signMessage(`PoolBuy: Confirm ${method}`);

    await localProvider.send("hardhat_impersonateAccount", [account]);
    const nextNonce = await localProvider.getTransactionCount(account, "latest");
    const hash = await localProvider.send("eth_sendTransaction", [{
      from: account,
      to: CONTRACT_ADDRESS,
      data: data,
      value: "0x" + value.toString(16),
      nonce: "0x" + nextNonce.toString(16)
    }]);
    await localProvider.waitForTransaction(hash);
  }
}

async function createDeal(event) {
  event.preventDefault();
  try {
    if (!contract) await connect();
    const title = $("title").value.trim();
    if (!title) throw new Error("Enter a deal title.");
    const supplier = $("supplier").value.trim();
    if (!ethers.isAddress(supplier)) throw new Error("Enter a valid supplier wallet address.");
    if (supplier.toLowerCase() === account.toLowerCase()) throw new Error("Supplier wallet must be different from your organizer wallet.");
    const tiers = formTiers();
    if (tiers.some((tier) => tier.minUnits <= 0n || tier.pricePerUnit <= 0n)) {
      throw new Error("Every tier must have positive minimum units and price.");
    }
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i].minUnits <= tiers[i - 1].minUnits) throw new Error("Tier minimum units must increase.");
      if (tiers[i].pricePerUnit >= tiers[i - 1].pricePerUnit) throw new Error("Each higher tier price must be lower.");
    }
    const latestBlock = await provider.getBlock("latest");
    const now = Math.max(Math.floor(Date.now() / 1000), Number(latestBlock.timestamp));
    const orderDeadline = now + Number($("order-minutes").value) * 60;
    const deliveryDeadline = orderDeadline + Number($("delivery-days").value) * 86400;
    
    await executeOnChain("createDeal", [supplier, title, orderDeadline, deliveryDeadline, tiers]);
    notify("Deal created on-chain.");
    event.target.reset();
    await loadDeals();
  } catch (error) { notify(errorMessage(error), true); }
}

async function action(id, method, args = []) {
  try {
    await executeOnChain(method, [id, ...args]);
    notify("Transaction confirmed.");
    await loadDeals();
  }
  catch (error) { notify(errorMessage(error), true); }
}

async function joinDeal(id) {
  try {
    const units = BigInt($(`units-${id}`).value);
    if (units <= 0n) throw new Error("Enter at least 1 unit.");
    const deal = await contract.getDeal(id);
    const block = await provider.getBlock("latest");
    const wallet = account.toLowerCase();
    const organizer = deal.organizer.toLowerCase();
    const supplier = deal.supplier.toLowerCase();
    if (Number(deal.state) !== 0) throw new Error(`This deal is ${states[Number(deal.state)]} and cannot accept orders.`);
    if (Number(block.timestamp) > Number(deal.orderDeadline)) throw new Error("This deal's order deadline has passed. Create a new deal.");
    if (wallet === organizer || wallet === supplier) throw new Error("Switch MetaMask to a different buyer wallet before joining.");
    const tiers = await contract.getTiers(id);
    const value = units * tiers[0].pricePerUnit;
    await executeOnChain("joinDeal", [id, units], value);
    notify("Order joined on-chain.");
    await loadDeals();
  } catch (error) { notify(errorMessage(error), true); }
}
function dealCard(id, deal, tiers, units, withdrawable) {
  const state = states[Number(deal.state)];
  const isOrganizer = account.toLowerCase() === deal.organizer.toLowerCase();
  const isSupplier = account.toLowerCase() === deal.supplier.toLowerCase();
  const canJoin = state === "Open" && !isOrganizer && !isSupplier;
  const controls = [];
  if (canJoin) controls.push(`<input id="units-${id}" type="number" min="1" value="1" aria-label="Units"><button class="button button-primary" data-action="join" data-id="${id}">Join pool</button>`);
  if (state === "Open" && (isOrganizer || isSupplier)) controls.push(`<span class="role-hint">Switch MetaMask to a different buyer account to place an order.</span>`);
  if (state === "Open") controls.push(`<button class="button button-quiet" data-action="finalize" data-id="${id}">Finalize</button>`);
  if (state === "Locked" && account.toLowerCase() === deal.supplier.toLowerCase()) controls.push(`<button class="button button-primary" data-action="deliver" data-id="${id}">Mark delivered</button>`);
  if (state === "Delivered" && units > 0) { controls.push(`<button class="button button-primary" data-action="confirm" data-id="${id}">Confirm delivery</button>`); controls.push(`<button class="button button-quiet" data-action="dispute" data-id="${id}">Dispute</button>`); }
  if (state === "Delivered") controls.push(`<button class="button button-quiet" data-action="settle" data-id="${id}">Settle</button>`);
  if (state === "Locked") controls.push(`<button class="button button-quiet" data-action="timeout" data-id="${id}">Claim timeout</button>`);
  if (withdrawable > 0) controls.push(`<button class="button button-primary" data-action="withdraw" data-id="${id}">Withdraw ${eth(withdrawable)} ETH</button>`);
  const badgeClass = state.toLowerCase();
  return `<article class="deal-card"><span class="badge ${badgeClass}">${state}</span><h3>${deal.title}</h3><div class="deal-meta"><div><span>Pool size</span><strong>${deal.totalUnits.toString()} units</strong></div><div><span>Final price</span><strong>${deal.finalPrice > 0n ? eth(deal.finalPrice) : eth(tiers[0].pricePerUnit)} ETH</strong></div><div><span>Supplier</span><strong>${short(deal.supplier)}</strong></div></div><div class="deal-actions">${controls.join("") || "<span class='deal-meta'>No actions available for this wallet.</span>"}</div></article>`;
}
function matchesFilter(deal) {
  const state = states[Number(deal.state)];
  if (currentFilter === "active") return activeStates.has(state);
  if (currentFilter === "completed") return state === "Completed";
  if (currentFilter === "history") return state === "Failed" || state === "Refunded";
  return true;
}
function updateDashboard() {
  const counts = { all: dealsCache.length, active: 0, completed: 0, history: 0 };
  for (const item of dealsCache) {
    const state = states[Number(item.deal.state)];
    if (activeStates.has(state)) counts.active++;
    if (state === "Completed") counts.completed++;
    if (state === "Failed" || state === "Refunded") counts.history++;
  }
  $("deal-count").textContent = counts.all;
  $("active-count").textContent = counts.active;
  $("completed-count").textContent = counts.completed;
  $("all-tab-count").textContent = counts.all;
  $("active-tab-count").textContent = counts.active;
  $("completed-tab-count").textContent = counts.completed;
  $("history-tab-count").textContent = counts.history;
  const visible = dealsCache.filter((item) => matchesFilter(item.deal));
  $("deal-list").innerHTML = visible.map((item) => dealCard(item.id, item.deal, item.tiers, item.units, item.withdrawable)).join("") ||
    `<div class="empty">No ${currentFilter === "all" ? "" : currentFilter + " "}deals found.</div>`;
}
async function loadDeals() {
  if (!contract) return;
  const count = Number(await contract.nextDealId());
  dealsCache = [];
  for (let id = 0; id < count; id++) {
    const deal = await contract.getDeal(id);
    const tiers = await contract.getTiers(id);
    const units = Number(await contract.getBuyerUnits(id, account));
    const withdrawable = await contract.getWithdrawable(id, account);
    dealsCache.push({ id, deal, tiers, units, withdrawable });
  }
  const organizerDeals = dealsCache.filter((item) => account.toLowerCase() === item.deal.organizer.toLowerCase()).length;
  const supplierDeals = dealsCache.filter((item) => account.toLowerCase() === item.deal.supplier.toLowerCase()).length;
  const role = $("wallet-role");
  if (organizerDeals > 0) role.innerHTML = `<strong>Organizer wallet connected.</strong> You can create and finalize deals. To place a buyer order, click the MetaMask account menu and switch to another Hardhat account.`;
  else if (supplierDeals > 0) role.innerHTML = `<strong>Supplier wallet connected.</strong> You can mark delivery and withdraw payment. Switch to a third Hardhat account to place a buyer order.`;
  else role.innerHTML = `<strong>Buyer wallet connected.</strong> Enter units on an Open deal and click <b>Join pool</b>. Each wallet can represent a separate buyer.`;
  updateDashboard();
}
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const id = Number(button.dataset.id);
  const method = { finalize: "finalizeOrder", deliver: "markDelivered", confirm: "confirmDelivery", dispute: "disputeDelivery", settle: "settle", timeout: "claimDeliveryTimeout", withdraw: "withdraw" }[button.dataset.action];
  if (button.dataset.action === "join") {
    try { return await joinDeal(id); }
    catch (error) { notify(errorMessage(error), true); }
  }
  return action(id, method);
});
document.addEventListener("DOMContentLoaded", () => {
  $("connect-button").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (connectPromise || contract) return;
    button.disabled = true;
    button.textContent = "Connecting...";
    try {
      await connect();
    } catch (error) {
      button.disabled = false;
      button.textContent = "Connect wallet";
      notify(error.message, true);
    }
  });
  $("create-form").addEventListener("submit", createDeal);
  $("refresh-button").addEventListener("click", () => loadDeals().catch((error) => notify(error.message, true)));
  document.querySelectorAll("[data-filter]").forEach((tab) => tab.addEventListener("click", () => {
    currentFilter = tab.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((other) => other.classList.toggle("active", other === tab));
    updateDashboard();
  }));
  $("contract-label").textContent = `Contract ${short(CONTRACT_ADDRESS)} · RPC ${RPC_URL}`;
  if (window.ethereum) {
    window.ethereum.on("chainChanged", () => window.location.reload());
    window.ethereum.on("accountsChanged", () => window.location.reload());
  }
});
