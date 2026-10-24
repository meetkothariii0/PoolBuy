// Hardhat configuration
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@typechain/hardhat";
import "solidity-coverage";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      chainId: 31354,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31354,
    },
  },
  typechain: {
    outDir: "typechain",
    target: "ethers-v6",
  },
  mocha: {
    timeout: 20000,
  },
};

export default config;
