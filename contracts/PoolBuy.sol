// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title PoolBuy
 * @dev All‑or‑nothing group buying with automatic discount tiers.
 *
 * ## Lifecycle Overview
 * 1️⃣ **Create Deal** – Organizer defines supplier, deadlines and price tiers.
 * 2️⃣ **Join Deal** – Buyers deposit the highest tier price per unit.
 * 3️⃣ **Finalize Order** – After the order deadline the final price is chosen based on total units.
 *    * If total units < tier0.minUnits → **Failed** (full refunds).
 *    * Otherwise → **Locked** (escrow holds funds).
 * 4️⃣ **Delivery** – Supplier marks as delivered before delivery deadline.
 * 5️⃣ **Buyer Confirmation** – Buyers have a 3‑day window to confirm or dispute.
 *    * ≥50 % of units confirm → supplier gets paid.
 *    * >25 % of units dispute → **Refunded** (escrow back to buyers).
 *    * Otherwise (no disputes) → supplier gets paid after window expires.
 * 6️⃣ **Settlement** – Funds are released according to the outcome.
 *
 * ### Example tier ladder
 * | Tier | minUnits | pricePerUnit |
 * |------|----------|--------------|
 * | 0    | 10       | 100 wei |
 * | 1    | 50       | 80 wei  |
 * | 2    | 100      | 70 wei  |
 *
 * If 120 units are ordered, final price = 70 wei, each buyer receives a rebate of
 * `(100‑70) * units`.
 */

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract PoolBuy is ReentrancyGuard {
    // ---------- Types ----------
    enum State { Open, Locked, Delivered, Completed, Failed, Refunded }
    struct Tier {
        uint256 minUnits;      // inclusive minimum units for this tier
        uint256 pricePerUnit;  // wei per unit, strictly decreasing with higher tiers
    }
    struct Deal {
        address organizer;
        address supplier;
        string title;
        uint256 orderDeadline;    // timestamp
        uint256 deliveryDeadline; // timestamp
        Tier[] tiers;
        uint256 totalUnits;       // sum of buyer units
        uint256 finalPrice;       // price per unit after finalisation
        State state;
        uint256 escrow;           // total wei deposited (includes rebates)
        uint256 confirmedUnits;   // units that have confirmed delivery
        uint256 disputedUnits;    // units that have disputed delivery
        uint256 confirmDeadline;  // timestamp = delivery time + 3 days
        bool supplierWithdrawn;
    }
    struct BuyerInfo {
        uint256 units;     // total units purchased
        uint256 withdrawn; // amount already withdrawn (rebates + refunds)
        bool hasConfirmed;
        bool hasDisputed;
    }

    // ---------- Storage ----------
    uint256 public nextDealId;
    mapping(uint256 => Deal) public deals; // dealId => Deal
    mapping(uint256 => mapping(address => BuyerInfo)) public buyers; // dealId => buyer => info

    // ---------- Events ----------
    event DealCreated(uint256 indexed id, address indexed organizer, address indexed supplier);
    event BuyerJoined(uint256 indexed id, address indexed buyer, uint256 units, uint256 amount);
    event BuyerLeft(uint256 indexed id, address indexed buyer, uint256 units, uint256 refund);
    event DealLocked(uint256 indexed id, uint256 finalPrice);
    event DealFailed(uint256 indexed id);
    event DeliveryMarked(uint256 indexed id);
    event DeliveryConfirmed(uint256 indexed id, address indexed buyer, uint256 units);
    event DeliveryDisputed(uint256 indexed id, address indexed buyer, uint256 units);
    event DealCompleted(uint256 indexed id);
    event DealRefunded(uint256 indexed id);
    event Withdrawal(uint256 indexed id, address indexed to, uint256 amount);

    // ---------- Errors ----------
    error Unauthorized();
    error InvalidState();
    error DeadlinePassed();
    error InvalidTier();
    error InsufficientPayment();
    error NoUnits();
    error AlreadyConfirmed();
    error AlreadyDisputed();
    error ZeroWithdrawable();
    error OrganizerIsSupplier();
    error TooManyTiers();
    error TierOrderInvalid();

    // ---------- Modifiers ----------
    modifier onlyOrganizer(uint256 id) {
        if (msg.sender != deals[id].organizer) revert Unauthorized();
        _;
    }
    modifier onlySupplier(uint256 id) {
        if (msg.sender != deals[id].supplier) revert Unauthorized();
        _;
    }
    modifier onlyBuyer(uint256 id) {
        if (buyers[id][msg.sender].units == 0) revert NoUnits();
        _;
    }

    // ---------- Helper Functions ----------
    function _getDeal(uint256 id) internal view returns (Deal storage) {
        if (id >= nextDealId) revert InvalidState();
        return deals[id];
    }

    function _currentPrice(uint256 id) internal view returns (uint256) {
        Deal storage d = deals[id];
        for (uint256 i = d.tiers.length; i > 0; i--) {
            Tier memory t = d.tiers[i - 1];
            if (d.totalUnits >= t.minUnits) return t.pricePerUnit;
        }
        return d.tiers[0].pricePerUnit; // fallback
    }

    // ---------- Public Functions ----------
    /**
     * @dev Create a new deal.
     */
    function createDeal(
        address supplier,
        string calldata title,
        uint256 orderDeadline,
        uint256 deliveryDeadline,
        Tier[] calldata tiers
    ) external returns (uint256) {
        if (supplier == msg.sender) revert OrganizerIsSupplier();
        if (orderDeadline <= block.timestamp) revert DeadlinePassed();
        if (deliveryDeadline <= orderDeadline) revert DeadlinePassed();
        uint256 len = tiers.length;
        if (len == 0 || len > 5) revert TooManyTiers();
        // validate ordering: ascending minUnits, descending price
        for (uint256 i = 0; i < len; i++) {
            if (tiers[i].minUnits == 0) revert InvalidTier();
            if (i > 0) {
                if (tiers[i].minUnits <= tiers[i - 1].minUnits) revert TierOrderInvalid();
                if (tiers[i].pricePerUnit >= tiers[i - 1].pricePerUnit) revert TierOrderInvalid();
            }
        }
        uint256 id = nextDealId++;
        Deal storage d = deals[id];
        d.organizer = msg.sender;
        d.supplier = supplier;
        d.title = title;
        d.orderDeadline = orderDeadline;
        d.deliveryDeadline = deliveryDeadline;
        d.state = State.Open;
        for (uint256 i = 0; i < len; i++) {
            d.tiers.push(tiers[i]);
        }
        emit DealCreated(id, msg.sender, supplier);
        return id;
    }

    /**
     * @dev Join an open deal before the order deadline. Pay tier‑0 price per unit.
     */
    function joinDeal(uint256 id, uint256 units) external payable nonReentrant {
        Deal storage d = _getDeal(id);
        if (d.state != State.Open) revert InvalidState();
        if (block.timestamp > d.orderDeadline) revert DeadlinePassed();
        if (msg.sender == d.organizer || msg.sender == d.supplier) revert Unauthorized();
        if (units == 0) revert NoUnits();
        uint256 pricePerUnit = d.tiers[0].pricePerUnit;
        if (msg.value != units * pricePerUnit) revert InsufficientPayment();
        BuyerInfo storage b = buyers[id][msg.sender];
        b.units += units;
        d.totalUnits += units;
        d.escrow += msg.value;
        emit BuyerJoined(id, msg.sender, units, msg.value);
    }

    /**
     * @dev Leave an open deal before the order deadline and get full refund.
     */
    function leaveDeal(uint256 id) external nonReentrant {
        Deal storage d = _getDeal(id);
        if (d.state != State.Open) revert InvalidState();
        if (block.timestamp > d.orderDeadline) revert DeadlinePassed();
        BuyerInfo storage b = buyers[id][msg.sender];
        if (b.units == 0) revert NoUnits();
        uint256 refundAmt = b.units * d.tiers[0].pricePerUnit;
        d.totalUnits -= b.units;
        d.escrow -= refundAmt;
        uint256 units = b.units;
        b.units = 0;
        b.withdrawn = refundAmt; // mark as withdrawn
        (bool sent, ) = msg.sender.call{value: refundAmt}("");
        require(sent, "Refund failed");
        emit BuyerLeft(id, msg.sender, units, refundAmt);
    }

    /**
     * @dev Finalise the order after the order deadline.
     */
    function finalizeOrder(uint256 id) external nonReentrant {
        Deal storage d = _getDeal(id);
        if (d.state != State.Open) revert InvalidState();
        if (block.timestamp <= d.orderDeadline) revert DeadlinePassed();
        // determine final price according to totalUnits
        for (uint256 i = d.tiers.length; i > 0; i--) {
            Tier memory t = d.tiers[i - 1];
            if (d.totalUnits >= t.minUnits) {
                d.finalPrice = t.pricePerUnit;
                break;
            }
        }
        // check minimum tier0
        if (d.totalUnits < d.tiers[0].minUnits) {
            d.state = State.Failed;
            emit DealFailed(id);
            return;
        }
        d.state = State.Locked;
        emit DealLocked(id, d.finalPrice);
    }

    /**
     * @dev Supplier marks the deal as delivered.
     */
    function markDelivered(uint256 id) external onlySupplier(id) nonReentrant {
        Deal storage d = _getDeal(id);
        if (d.state != State.Locked) revert InvalidState();
        if (block.timestamp > d.deliveryDeadline) revert DeadlinePassed();
        d.state = State.Delivered;
        d.confirmDeadline = block.timestamp + 3 days;
        emit DeliveryMarked(id);
    }

    /**
     * @dev Buyer confirms delivery during the 3‑day window.
     */
    function confirmDelivery(uint256 id) external onlyBuyer(id) nonReentrant {
        Deal storage d = _getDeal(id);
        if (d.state != State.Delivered) revert InvalidState();
        if (block.timestamp > d.confirmDeadline) revert DeadlinePassed();
        BuyerInfo storage b = buyers[id][msg.sender];
        if (b.hasConfirmed) revert AlreadyConfirmed();
        if (b.hasDisputed) revert AlreadyDisputed();
        b.hasConfirmed = true;
        d.confirmedUnits += b.units;
        emit DeliveryConfirmed(id, msg.sender, b.units);
    }

    /**
     * @dev Buyer disputes delivery during the 3‑day window.
     */
    function disputeDelivery(uint256 id) external onlyBuyer(id) nonReentrant {
        Deal storage d = _getDeal(id);
        if (d.state != State.Delivered) revert InvalidState();
        if (block.timestamp > d.confirmDeadline) revert DeadlinePassed();
        BuyerInfo storage b = buyers[id][msg.sender];
        if (b.hasConfirmed) revert AlreadyConfirmed();
        if (b.hasDisputed) revert AlreadyDisputed();
        b.hasDisputed = true;
        d.disputedUnits += b.units;
        emit DeliveryDisputed(id, msg.sender, b.units);
    }

    /**
     * @dev Settle the deal after the confirmation window or when thresholds are met.
     */
    function settle(uint256 id) external nonReentrant {
        Deal storage d = _getDeal(id);
        if (d.state != State.Delivered) revert InvalidState();
        bool windowClosed = block.timestamp > d.confirmDeadline;
        if (!windowClosed) {
            if (d.confirmedUnits * 2 >= d.totalUnits) {
                _paySupplier(id);
                return;
            }
            if (d.disputedUnits * 4 > d.totalUnits) {
                _refundAll(id);
                return;
            }
            revert InvalidState();
        }
        // after window
        if (d.disputedUnits * 4 > d.totalUnits) {
            _refundAll(id);
        } else {
            _paySupplier(id);
        }
    }

    /**
     * @dev Anyone can trigger a refund if supplier missed the delivery deadline.
     */
    function claimDeliveryTimeout(uint256 id) external nonReentrant {
        Deal storage d = _getDeal(id);
        if (d.state != State.Locked) revert InvalidState();
        if (block.timestamp <= d.deliveryDeadline) revert DeadlinePassed();
        _refundAll(id);
    }

    /**
     * @dev Withdraw rebates / refunds for buyers or payment for the supplier.
     */
    function withdraw(uint256 id) external nonReentrant {
        Deal storage d = _getDeal(id);
        if (d.state == State.Open) revert InvalidState();
        BuyerInfo storage b = buyers[id][msg.sender];
        uint256 amount;
        // Buyer path
        if (b.units > 0) {
            if (d.state == State.Failed || d.state == State.Refunded) {
                uint256 totalDeposit = b.units * d.tiers[0].pricePerUnit;
                amount = totalDeposit - b.withdrawn;
            } else if (d.state == State.Completed) {
                uint256 rebate = b.units * (d.tiers[0].pricePerUnit - d.finalPrice);
                amount = rebate - b.withdrawn;
            }
            if (amount == 0) revert ZeroWithdrawable();
            b.withdrawn += amount;
            (bool sent, ) = msg.sender.call{value: amount}("");
            require(sent, "Withdraw failed");
            emit Withdrawal(id, msg.sender, amount);
            return;
        }
        // Supplier path
        if (msg.sender == d.supplier) {
            if (d.state != State.Completed) revert InvalidState();
            if (d.supplierWithdrawn) revert ZeroWithdrawable();
            uint256 supplierAmount = d.totalUnits * d.finalPrice;
            if (supplierAmount == 0) revert ZeroWithdrawable();
            d.supplierWithdrawn = true;
            (bool sent, ) = msg.sender.call{value: supplierAmount}("");
            require(sent, "Supplier withdraw failed");
            emit Withdrawal(id, msg.sender, supplierAmount);
            return;
        }
        revert Unauthorized();
    }

    // ---------- Internal Payments ----------
    function _paySupplier(uint256 id) internal {
        Deal storage d = deals[id];
        d.state = State.Completed;
        emit DealCompleted(id);
    }

    function _refundAll(uint256 id) internal {
        Deal storage d = deals[id];
        d.state = State.Refunded;
        emit DealRefunded(id);
    }

    // ---------- View Functions ----------
    function getDeal(uint256 id) external view returns (
        address organizer,
        address supplier,
        string memory title,
        uint256 orderDeadline,
        uint256 deliveryDeadline,
        uint256 totalUnits,
        uint256 finalPrice,
        State state,
        uint256 escrow,
        uint256 confirmedUnits,
        uint256 disputedUnits
    ) {
        Deal storage d = deals[id];
        return (
            d.organizer,
            d.supplier,
            d.title,
            d.orderDeadline,
            d.deliveryDeadline,
            d.totalUnits,
            d.finalPrice,
            d.state,
            d.escrow,
            d.confirmedUnits,
            d.disputedUnits
        );
    }

    function getTiers(uint256 id) external view returns (Tier[] memory) {
        return deals[id].tiers;
    }

    function getBuyerUnits(uint256 id, address buyer) external view returns (uint256) {
        return buyers[id][buyer].units;
    }

    function currentPrice(uint256 id) external view returns (uint256) {
        return _currentPrice(id);
    }

    function getWithdrawable(uint256 id, address user) external view returns (uint256) {
        BuyerInfo storage b = buyers[id][user];
        Deal storage d = deals[id];
        if (b.units == 0) return 0;
        if (d.state == State.Failed || d.state == State.Refunded) {
            uint256 tot = b.units * d.tiers[0].pricePerUnit;
            return tot - b.withdrawn;
        }
        if (d.state == State.Completed) {
            uint256 rebate = b.units * (d.tiers[0].pricePerUnit - d.finalPrice);
            return rebate - b.withdrawn;
        }
        return 0;
    }
}
