// TODO replace this with a copy pasted abi into ../abis.ts
import { DisputeGameFactoryAbi } from '@tevm/opstack'
import type { Address } from 'abitype'
import { readContract } from '~viem/actions/index.js'
import { decodeAbiParameters } from '~viem/index.js'
import type { Client } from '../../../clients/createClient.js'
import type { Transport } from '../../../clients/transports/createTransport.js'
import { ContractFunctionRevertedError } from '../../../errors/contract.js'
import type { ErrorType } from '../../../errors/utils.js'
import type { Account } from '../../../types/account.js'
import type {
  Chain,
  DeriveChain,
  GetChainParameter,
} from '../../../types/chain.js'
import { poll } from '../../../utils/poll.js'
import { portal2Abi } from '../abis.js'
import type { GetContractAddressParameter } from '../types/contract.js'
import {
  type GetL2OutputErrorType,
  type GetL2OutputReturnType,
  getL2Output,
} from './getL2Output.js'
import { getPortalVersion } from './getPortalVersion.js'
import {
  type GetTimeToNextL2OutputErrorType,
  type GetTimeToNextL2OutputParameters,
  getTimeToNextL2Output,
} from './getTimeToNextL2Output.js'

export type WaitForNextL2OutputParameters<
  chain extends Chain | undefined = Chain | undefined,
  chainOverride extends Chain | undefined = Chain | undefined,
  _derivedChain extends Chain | undefined = DeriveChain<chain, chainOverride>,
> = GetChainParameter<chain, chainOverride> &
  GetContractAddressParameter<
    _derivedChain,
    'l2OutputOracle' | 'portal' | 'disputeGameFactory'
  > & {
    /**
     * The buffer to account for discrepencies between non-deterministic time intervals.
     * @default 1.1
     */
    intervalBuffer?: GetTimeToNextL2OutputParameters['intervalBuffer']
    l2BlockNumber: bigint
    /**
     * Polling frequency (in ms). Defaults to Client's pollingInterval config.
     * @default client.pollingInterval
     */
    pollingInterval?: number
    /**
     * Address of the portal contract.
     */
    portalAddress?: Address
    /**
     * Address of the dispute game factory contract.
     */
    disputeGameAddress?: Address
  }
export type WaitForNextL2OutputReturnType = GetL2OutputReturnType
export type WaitForNextL2OutputErrorType =
  | GetL2OutputErrorType
  | GetTimeToNextL2OutputErrorType
  | ErrorType

/**
 * Waits for the next L2 output (after the provided block number) to be submitted.
 *
 * - Docs: https://viem.sh/op-stack/actions/waitForNextL2Output
 *
 * @param client - Client to use
 * @param parameters - {@link WaitForNextL2OutputParameters}
 * @returns The L2 transaction hash. {@link WaitForNextL2OutputReturnType}
 *
 * @example
 * import { createPublicClient, http } from 'viem'
 * import { getBlockNumber } from 'viem/actions'
 * import { mainnet, optimism } from 'viem/chains'
 * import { waitForNextL2Output } from 'viem/op-stack'
 *
 * const publicClientL1 = createPublicClient({
 *   chain: mainnet,
 *   transport: http(),
 * })
 * const publicClientL2 = createPublicClient({
 *   chain: optimism,
 *   transport: http(),
 * })
 *
 * const l2BlockNumber = await getBlockNumber(publicClientL2)
 * await waitForNextL2Output(publicClientL1, {
 *   l2BlockNumber,
 *   targetChain: optimism
 * })
 */
export async function waitForNextL2Output<
  chain extends Chain | undefined,
  account extends Account | undefined,
  chainOverride extends Chain | undefined = undefined,
>(
  client: Client<Transport, chain, account>,
  parameters: WaitForNextL2OutputParameters<chain, chainOverride>,
): Promise<WaitForNextL2OutputReturnType> {
  const { pollingInterval = client.pollingInterval } = parameters

  const { chain, targetChain } = parameters

  const portalAddress = (() => {
    if (parameters.portalAddress) return parameters.portalAddress
    if (chain) return targetChain!.contracts.portal[chain.id].address
    return Object.values(targetChain!.contracts.portal)[0].address
  })()

  const disputeGameAddress = (() => {
    if (parameters.disputeGameAddress) return parameters.disputeGameAddress
    if (chain)
      return targetChain!.contracts.disputeGameFactory[chain.id].address
    return Object.values(targetChain!.contracts.disputeGameFactory)[0].address
  })()

  const version = await getPortalVersion(client, {
    portalAddress: portalAddress,
  })

  const isLegacy = version.major < 3

  // This entire expression can be removed after mainnet and testnet are migrated to v3
  const { seconds } = !isLegacy
    ? { seconds: 0 }
    : await getTimeToNextL2Output(client, parameters)

  return new Promise((resolve, reject) => {
    poll(
      async ({ unpoll }) => {
        // Can remove this block once mainnet and testnet is migrated to v3
        if (isLegacy) {
          try {
            const output = await getL2Output(client, parameters)
            unpoll()
            resolve(output)
          } catch (e) {
            const error = e as GetL2OutputErrorType
            if (!(error.cause instanceof ContractFunctionRevertedError)) {
              unpoll()
              reject(e)
            }
          }
        }

        try {
          // Get the total game count from the DisputeGameFactory since that will give us the end of
          // the array that we're searching over. We'll then use that to find the latest games.
          const gameCount = await readContract(client, {
            abi: DisputeGameFactoryAbi,
            functionName: 'gameCount',
            args: [],
            // TODO get this address
            address: disputeGameAddress,
          })
          const gameType = await readContract(client, {
            abi: portal2Abi,
            functionName: 'respectedGameType',
            // TODO get this address
            address: portalAddress,
          })

          // Find the latest 100 games (or as many as we can up to 100).
          const latestGames = await readContract(client, {
            abi: DisputeGameFactoryAbi,
            functionName: 'findLatestGames',
            address: disputeGameAddress,
            args: [
              gameType,
              BigInt(Math.max(0, Number(gameCount - 1n))),
              BigInt(Math.min(100, Number(gameCount))),
            ],
          })
          // Find a game with a block number that is greater than or equal to the block number that the
          // message was included in. We can use this proposal to prove the message to the portal.
          let match: any
          for (const game of latestGames) {
            const [blockNumber] = decodeAbiParameters(
              [{ type: 'uint256' }],
              game.extraData,
            )
            if (blockNumber > parameters.l2BlockNumber) {
              match = {
                ...game,
                l2BlockNumber: blockNumber,
              }
              unpoll()
              resolve(match)
            }
          }
        } catch (e) {
          unpoll()
          reject(e)
        }
      },
      {
        interval: pollingInterval,
        initialWaitTime: async () => seconds * 1000,
      },
    )
  })
}
