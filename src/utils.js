import fetch from 'isomorphic-fetch';

import { CALL_OP, ZERO_ADDRESS } from '~/common/constants';

import CoreError, { RequestError, ErrorCodes } from '~/common/error';
import TransactionQueue from '~/common/queue';
import checkAccount from '~/common/checkAccount';
import checkOptions from '~/common/checkOptions';
import loop from '~/common/loop';
import parameterize from '~/common/parameterize';
import { formatTypedData, signTypedData } from '~/common/typedData';
import { getSafeContract } from '~/common/getContracts';

const transactionQueue = new TransactionQueue();

async function request(endpoint, userOptions) {
  const options = checkOptions(userOptions, {
    path: {
      type: 'array',
    },
    method: {
      type: 'string',
      default: 'GET',
    },
    data: {
      type: 'object',
      default: {},
    },
    isTrailingSlash: {
      type: 'boolean',
      default: true,
    },
  });

  const { path, method, data } = options;

  const request = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  };

  let paramsStr = '';
  if (method === 'GET') {
    paramsStr = parameterize(data);
  } else {
    request.body = JSON.stringify(data);
  }

  const slash = options.isTrailingSlash ? '/' : '';

  const url = `${endpoint}/${path.join('/')}${slash}${paramsStr}`;

  try {
    return fetch(url, request).then((response) => {
      const contentType = response.headers.get('Content-Type');

      if (contentType && contentType.includes('application/json')) {
        return response.json().then((json) => {
          if (response.status >= 400) {
            throw new RequestError(url, json, response.status);
          }

          return json;
        });
      } else {
        if (response.status >= 400) {
          throw new RequestError(url, response.body, response.status);
        }

        return response.body;
      }
    });
  } catch (err) {
    throw new RequestError(url, err.message);
  }
}

async function requestRelayer(endpoint, userOptions) {
  const options = checkOptions(userOptions, {
    path: {
      type: 'array',
    },
    version: {
      type: 'number',
      default: 1,
    },
    method: {
      type: 'string',
      default: 'GET',
    },
    data: {
      type: 'object',
      default: {},
    },
  });

  const { path, method, data, version } = options;

  return request(endpoint, {
    path: ['api', `v${version}`].concat(path),
    method,
    data,
  });
}

async function requestGraph(endpoint, subgraphName, userOptions) {
  const options = checkOptions(userOptions, {
    query: {
      type: 'string',
    },
    variables: {
      type: 'object',
      default: {},
    },
  });

  const query = options.query.replace(/\s\s+/g, ' ');

  const variables =
    Object.keys(options.variables).length === 0 ? undefined : options.variables;

  const response = await request(endpoint, {
    path: ['subgraphs', 'name', subgraphName],
    method: 'POST',
    data: {
      query,
      variables,
    },
    isTrailingSlash: false,
  });

  return response.data;
}

async function estimateTransactionCosts(
  endpoint,
  {
    safeAddress,
    to,
    txData,
    value = 0,
    gasToken = ZERO_ADDRESS,
    operation = CALL_OP,
  },
) {
  return await requestRelayer(endpoint, {
    path: ['safes', safeAddress, 'transactions', 'estimate'],
    method: 'POST',
    version: 2,
    data: {
      safe: safeAddress,
      data: txData,
      to,
      value,
      operation,
      gasToken,
    },
  });
}

/**
 * Manages transaction queue to finalize currently running tasks and starts the
 * next one when ready.
 *
 * @param {Web3} web3 - Web3 instance
 * @param {string} endpoint - URL of relayer Service
 * @param {string} safeAddress - address of Safe
 * @param {number} pendingTicketId - id of the task
 */
async function waitForPendingTransactions(
  web3,
  endpoint,
  safeAddress,
  pendingTicketId,
) {
  await loop(
    async () => {
      // Check if transaction is ready and leave loop if yes
      if (!transactionQueue.isLocked(safeAddress)) {
        return transactionQueue.isNextInQueue(safeAddress, pendingTicketId);
      }

      // .. otherwise check what task is currently running
      const {
        txHash,
        nonce,
        ticketId: currentTicketId,
      } = transactionQueue.getCurrentTransaction(safeAddress);

      // Ask relayer if it finished
      try {
        const response = await requestRelayer(endpoint, {
          path: ['safes', safeAddress, 'transactions'],
          method: 'GET',
          version: 1,
          data: {
            limit: 1,
            ethereum_tx__tx_hash: txHash,
            nonce,
          },
        });

        // ... and unqueue the task in case it did!
        if (response.results.length === 1) {
          transactionQueue.unlockTransaction(safeAddress, currentTicketId);
          transactionQueue.unqueue(safeAddress, currentTicketId);
        }
      } catch {
        // Do nothing
      }

      return false;
    },
    (isReady) => {
      return isReady;
    },
  );
}

/**
 * Retreive an nonce and make sure it does not collide with currently
 * pending transactions already using it.
 *
 * @param {Web3} web3 - Web3 instance
 * @param {string} endpoint - URL of Relayer Service
 * @param {string} safeAddress - address of Safe
 */
async function requestNonce(web3, endpoint, safeAddress) {
  let nonce = null;

  try {
    const response = await requestRelayer(endpoint, {
      path: ['safes', safeAddress, 'transactions'],
      method: 'GET',
      version: 1,
      data: {
        limit: 1,
      },
    });

    nonce = response.results.length > 0 ? response.results[0].nonce : null;
  } catch {
    // Do nothing!
  }

  // Fallback to retreive nonce from Safe contract method (already incremented)
  if (nonce === null) {
    return await getSafeContract(web3, safeAddress).methods.nonce().call();
  }

  return `${parseInt(nonce, 10) + 1}`;
}

/**
 * Utils submodule for common transaction and relayer methods.
 *
 * @param {Web3} web3 - Web3 instance
 * @param {Object} contracts - common contract instances
 * @param {Object} globalOptions - global core options
 *
 * @return {Object} - utils module instance
 */
export default function createUtilsModule(web3, contracts, globalOptions) {
  const {
    graphNodeEndpoint,
    relayServiceEndpoint,
    subgraphName,
    usernameServiceEndpoint,
  } = globalOptions;

  const { hub } = contracts;

  return {
    /**
     * Convert to fractional monetary unit of Circles
     * named Freckles.
     *
     * @param {string|number} value - value in Circles
     *
     * @return {string} - value in Freckles
     */
    toFreckles: (value) => {
      return web3.utils.toWei(`${value}`, 'ether');
    },

    /**
     * Convert from Freckles to Circles number.
     *
     * @param {string|number} value - value in Freckles
     *
     * @return {number} - value in Circles
     */
    fromFreckles: (value) => {
      return parseInt(web3.utils.fromWei(`${value}`, 'ether'), 10);
    },

    /**
     * Send an API request to the Gnosis Relayer.
     *
     * @param {Object} userOptions - request options
     * @param {string[]} userOptions.path - API path as array
     * @param {number} userOptions.version - API version 1 or 2
     * @param {string} userOptions.method - API request method (GET, POST)
     * @param {Object} userOptions.data - data payload
     */
    requestRelayer: async (userOptions) => {
      return requestRelayer(relayServiceEndpoint, userOptions);
    },

    /**
     * Query the Graph Node with GraphQL.
     *
     * @param {Object} userOptions - query options
     * @param {string} userOptions.query - GraphQL query
     * @param {Object} userOptions.variables - GraphQL variables
     */
    requestGraph: async (userOptions) => {
      return requestGraph(graphNodeEndpoint, subgraphName, userOptions);
    },

    /**
     * Send Transaction to Relayer and pay with Circles Token.
     *
     * @param {Object} account - web3 account instance
     * @param {Object} userOptions - query options
     * @param {string} userOptions.safeAddress - address of Safe
     * @param {object} userOptions.txData - encoded transaction data
     *
     * @return {string} - transaction hash
     */
    executeTokenSafeTx: async (account, userOptions) => {
      checkAccount(web3, account);

      const options = checkOptions(userOptions, {
        safeAddress: {
          type: web3.utils.checkAddressChecksum,
        },
        to: {
          type: web3.utils.checkAddressChecksum,
        },
        txData: {
          type: web3.utils.isHexStrict,
        },
      });

      const { txData, safeAddress, to } = options;
      const operation = CALL_OP;
      const refundReceiver = ZERO_ADDRESS;
      const value = 0;

      // Get Circles Token of this Safe / User
      const tokenAddress = await hub.methods.userToToken(safeAddress).call();

      if (tokenAddress === ZERO_ADDRESS) {
        throw new CoreError(
          'Invalid Token address. Did you forget to deploy the Token?',
          ErrorCodes.TOKEN_NOT_FOUND,
        );
      }

      // Use Circles Token to pay for transaction fees
      const gasToken = tokenAddress;

      const { dataGas, safeTxGas, gasPrice } = await estimateTransactionCosts(
        relayServiceEndpoint,
        {
          gasToken,
          operation,
          safeAddress,
          to,
          txData,
          value,
        },
      );

      // Register transaction in waiting queue
      const ticketId = transactionQueue.queue(safeAddress);

      // Wait until transaction can be executed
      await waitForPendingTransactions(
        web3,
        relayServiceEndpoint,
        safeAddress,
        ticketId,
      );

      // Request nonce for Safe
      const nonce = await requestNonce(web3, relayServiceEndpoint, safeAddress);

      // Prepare EIP712 transaction data and sign it
      const typedData = formatTypedData(
        to,
        value,
        txData,
        operation,
        safeTxGas,
        dataGas,
        gasPrice,
        gasToken,
        refundReceiver,
        nonce,
        safeAddress,
      );

      const signature = signTypedData(web3, account.privateKey, typedData);

      // Send transaction to relayer
      try {
        const { txHash } = await requestRelayer(relayServiceEndpoint, {
          path: ['safes', safeAddress, 'transactions'],
          method: 'POST',
          version: 1,
          data: {
            to,
            value,
            data: txData,
            operation,
            signatures: [signature],
            safeTxGas,
            dataGas,
            gasPrice,
            nonce,
            gasToken,
          },
        });

        // Register transaction so we can check later if it finished
        transactionQueue.lockTransaction(safeAddress, {
          nonce,
          ticketId,
          txHash,
        });

        return txHash;
      } catch {
        transactionQueue.unlockTransaction(safeAddress, ticketId);
        transactionQueue.unqueue(safeAddress, ticketId);

        return null;
      }
    },

    /**
     * Send a transaction to the relayer which will be executed by it.
     * The gas costs will be estimated by the relayer before.
     *
     * @param {Object} account - web3 account instance
     * @param {Object} userOptions - query options
     * @param {string} userOptions.safeAddress - address of Safe
     * @param {string} userOptions.to - forwarded address (from is the relayer)
     * @param {object} userOptions.txData - encoded transaction data
     * @param {number} userOptions.value - value in Wei
     *
     * @return {string} - transaction hash
     */
    executeSafeTx: async (account, userOptions) => {
      checkAccount(web3, account);

      const options = checkOptions(userOptions, {
        safeAddress: {
          type: web3.utils.checkAddressChecksum,
        },
        to: {
          type: web3.utils.checkAddressChecksum,
        },
        gasToken: {
          type: web3.utils.checkAddressChecksum,
          default: ZERO_ADDRESS,
        },
        txData: {
          type: web3.utils.isHexStrict,
          default: '0x',
        },
        value: {
          type: 'number',
          default: 0,
        },
      });

      const { to, gasToken, txData, value, safeAddress } = options;
      const operation = CALL_OP;
      const refundReceiver = ZERO_ADDRESS;

      const { dataGas, gasPrice, safeTxGas } = await estimateTransactionCosts(
        relayServiceEndpoint,
        {
          gasToken,
          operation,
          safeAddress,
          to,
          txData,
          value,
        },
      );

      // Register transaction in waiting queue
      const ticketId = transactionQueue.queue(safeAddress);

      // Wait until Relayer allocates enough funds to pay for transaction
      const totalGasEstimate = web3.utils
        .toBN(dataGas)
        .add(new web3.utils.BN(safeTxGas))
        .mul(new web3.utils.BN(gasPrice));

      await loop(
        () => {
          return web3.eth.getBalance(safeAddress);
        },
        (balance) => {
          return web3.utils.toBN(balance).gte(totalGasEstimate);
        },
      );

      // Wait until transaction can be executed
      await waitForPendingTransactions(
        web3,
        relayServiceEndpoint,
        safeAddress,
        ticketId,
      );

      // Request nonce for Safe
      const nonce = await requestNonce(web3, relayServiceEndpoint, safeAddress);

      // Prepare EIP712 transaction data and sign it
      const typedData = formatTypedData(
        to,
        value,
        txData,
        operation,
        safeTxGas,
        dataGas,
        gasPrice,
        gasToken,
        refundReceiver,
        nonce,
        safeAddress,
      );

      const signature = signTypedData(web3, account.privateKey, typedData);

      // Send transaction to relayer
      try {
        const { txHash } = await requestRelayer(relayServiceEndpoint, {
          path: ['safes', safeAddress, 'transactions'],
          method: 'POST',
          version: 1,
          data: {
            to,
            value,
            data: txData,
            operation,
            signatures: [signature],
            safeTxGas,
            dataGas,
            gasPrice,
            nonce,
            gasToken,
          },
        });

        // Register transaction so we can check later if it finished
        transactionQueue.lockTransaction(safeAddress, {
          nonce,
          ticketId,
          txHash,
        });

        return txHash;
      } catch {
        transactionQueue.unlockTransaction(safeAddress, ticketId);
        transactionQueue.unqueue(safeAddress, ticketId);

        return null;
      }
    },

    /**
     * Make a request to the Circles server API.
     *
     * @param {Object} userOptions - API query options
     * @param {string} userOptions.path - API route
     * @param {string} userOptions.method - HTTP method
     * @param {object} userOptions.data - Request body (JSON)
     *
     * @return {Object} - API response
     */
    requestAPI: async (userOptions) => {
      const options = checkOptions(userOptions, {
        path: {
          type: 'array',
        },
        method: {
          type: 'string',
          default: 'GET',
        },
        data: {
          type: 'object',
          default: {},
        },
      });

      return request(usernameServiceEndpoint, {
        data: options.data,
        method: options.method,
        path: ['api'].concat(options.path),
      });
    },
  };
}
