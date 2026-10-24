// scripts/deploy.ts
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const PoolBuy = await ethers.getContractFactory("PoolBuy");
  const poolBuy = await PoolBuy.deploy();
  await poolBuy.waitForDeployment();
  const address = await poolBuy.getAddress();
  console.log("PoolBuy deployed to:", address);

  // Automatically sync to frontend/app.js
  const appJsPath = path.resolve(__dirname, "../frontend/app.js");
  if (fs.existsSync(appJsPath)) {
    let content = fs.readFileSync(appJsPath, "utf8");
    content = content.replace(/const CONTRACT_ADDRESS = "[^"]*";/, `const CONTRACT_ADDRESS = "${address}";`);
    fs.writeFileSync(appJsPath, content, "utf8");
    console.log("Synced address to frontend/app.js:", address);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
