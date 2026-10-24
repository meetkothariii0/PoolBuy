// SPDX-License-Identifier: MIT
import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { Contract } from "ethers";

describe("PoolBuy", function () {
  let poolBuy: Contract;
  let organizer: any, supplier: any, buyers: any[];
  const tier0Price = ethers.parseEther("0.1"); // 0.1 ETH per unit
  const tier1Price = ethers.parseEther("0.08");
  const tier2Price = ethers.parseEther("0.07");

  beforeEach(async function () {
    [organizer, supplier, ...buyers] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("PoolBuy", organizer);
    poolBuy = await Factory.deploy();
    await poolBuy.waitForDeployment();
  });

  async function createDeal() {
    const now = await time.latest();
    const orderDeadline = now + 60; // 1 minute
    const deliveryDeadline = now + 3600; // 1 hour
    const tiers = [
      { minUnits: 10, pricePerUnit: tier0Price },
      { minUnits: 50, pricePerUnit: tier1Price },
      { minUnits: 100, pricePerUnit: tier2Price },
    ];
    const tx = await poolBuy.createDeal(
      supplier.address,
      "Test Deal",
      orderDeadline,
      deliveryDeadline,
      tiers
    );
    await tx.wait();
    return (await poolBuy.nextDealId()) - 1n;
  }

  it("happy path – top tier reached, rebates, supplier paid", async function () {
    const dealId = await createDeal();
    // 5 buyers each 30 units => 150 units (top tier)
    for (let i = 0; i < 5; i++) {
      await poolBuy.connect(buyers[i]).joinDeal(dealId, 30, { value: tier0Price * 30n });
    }
    await time.increase(61);
    await poolBuy.finalizeOrder(dealId);
    await poolBuy.connect(supplier).markDelivered(dealId);
    for (let i = 0; i < 5; i++) {
      await poolBuy.connect(buyers[i]).confirmDelivery(dealId);
    }
    await poolBuy.settle(dealId);
    // supplier withdraws
    const supBalBefore = await ethers.provider.getBalance(supplier.address);
    await poolBuy.connect(supplier).withdraw(dealId);
    const supBalAfter = await ethers.provider.getBalance(supplier.address);
    expect(supBalAfter - supBalBefore).to.be.gt(0);
    // each buyer withdraws rebate
    const rebatePerUnit = tier0Price - tier2Price;
    for (let i = 0; i < 5; i++) {
      const expectedRebate = await poolBuy.getWithdrawable(dealId, buyers[i].address);
      await poolBuy.connect(buyers[i]).withdraw(dealId);
      expect(expectedRebate).to.equal(rebatePerUnit * 30n);
      expect(await poolBuy.getWithdrawable(dealId, buyers[i].address)).to.equal(0);
    }
  });

  it("minimum not reached – full refunds", async function () {
    const dealId = await createDeal();
    await poolBuy.connect(buyers[0]).joinDeal(dealId, 5, { value: tier0Price * 5n });
    await time.increase(61);
    await poolBuy.finalizeOrder(dealId);
    const deal = await poolBuy.getDeal(dealId);
    expect(deal.state).to.equal(4); // Failed
    const expectedRefund = await poolBuy.getWithdrawable(dealId, buyers[0].address);
    await poolBuy.connect(buyers[0]).withdraw(dealId);
    expect(expectedRefund).to.equal(tier0Price * 5n);
    expect(await poolBuy.getWithdrawable(dealId, buyers[0].address)).to.equal(0);
  });

  it("middle tier reached – correct price and rebates", async function () {
    const dealId = await createDeal();
    // 20 + 30 + 10 = 60 units (tier1)
    await poolBuy.connect(buyers[0]).joinDeal(dealId, 20, { value: tier0Price * 20n });
    await poolBuy.connect(buyers[1]).joinDeal(dealId, 30, { value: tier0Price * 30n });
    await poolBuy.connect(buyers[2]).joinDeal(dealId, 10, { value: tier0Price * 10n });
    await time.increase(61);
    await poolBuy.finalizeOrder(dealId);
    const info = await poolBuy.getDeal(dealId);
    expect(info.finalPrice).to.equal(tier1Price);
    await poolBuy.connect(supplier).markDelivered(dealId);
    for (let i = 0; i < 3; i++) {
      await poolBuy.connect(buyers[i]).confirmDelivery(dealId);
    }
    await poolBuy.settle(dealId);
    const rebatePerUnit = tier0Price - tier1Price;
    const expectedRebate = await poolBuy.getWithdrawable(dealId, buyers[0].address);
    await poolBuy.connect(buyers[0]).withdraw(dealId);
    expect(expectedRebate).to.equal(rebatePerUnit * 20n);
    expect(await poolBuy.getWithdrawable(dealId, buyers[0].address)).to.equal(0);
  });
});
