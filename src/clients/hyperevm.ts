import { createPublicClient, defineChain, http, parseAbi, type Address } from "viem";
import { DEPLOYMENT } from "../protocol/deployment.js";

const factoryAbi = parseAbi(["function computeProxyAddress(address user) view returns (address)"]);

export type HyperEvm = {
  // Independent on-chain derivation of the per-user deposit proxy, used to
  // cross-check the address the relayer hands back.
  computeDepositProxy: (user: Address) => Promise<Address>;
};

export const createHyperEvm = (rpcUrl: string): HyperEvm => {
  const chain = defineChain({
    id: DEPLOYMENT.chainId,
    name: "HyperEVM",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 10_000 }) });
  return {
    computeDepositProxy: async (user) =>
      (
        await client.readContract({
          address: DEPLOYMENT.contracts.depositProxyFactory,
          abi: factoryAbi,
          functionName: "computeProxyAddress",
          args: [user],
        })
      ).toLowerCase() as Address,
  };
};
