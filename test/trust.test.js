import createCore from './helpers/core';
import getAccount from './helpers/account';
import getTrustConnection from './helpers/getTrustConnection';
import web3 from './helpers/web3';
import { deploySafeAndToken } from './helpers/transactions';

let account;
let otherAccount;
let core;
let safeAddress;
let otherSafeAddress;

beforeAll(async () => {
  account = getAccount();
  otherAccount = getAccount(3);
  core = createCore();
});

describe('Trust', () => {
  beforeAll(() =>
    Promise.all([
      deploySafeAndToken(core, account),
      deploySafeAndToken(core, otherAccount),
    ]).then((result) => {
      safeAddress = result[0].safeAddress;
      otherSafeAddress = result[1].safeAddress;
    }),
  );

  it('should trust someone', async () => {
    const response = await core.trust.addConnection(account, {
      user: otherSafeAddress,
      canSendTo: safeAddress,
      limitPercentage: 44,
    });

    expect(web3.utils.isHexStrict(response)).toBe(true);

    const connection = await core.utils.loop(
      () => {
        return getTrustConnection(core, account, safeAddress, otherSafeAddress);
      },
      (isReady) => isReady,
      { label: 'Wait for the graph to index newly added trust connection' },
    );

    expect(connection.safeAddress).toBe(otherSafeAddress);
    expect(connection.isIncoming).toBe(true);
    expect(connection.isOutgoing).toBe(false);
    expect(connection.limitPercentageIn).toBe(44);
    expect(connection.limitPercentageOut).toBe(0);

    let otherConnection = await core.utils.loop(
      () => {
        return getTrustConnection(
          core,
          otherAccount,
          otherSafeAddress,
          safeAddress,
        );
      },
      (isReady) => isReady,
      { label: 'Wait for trust connection to be indexed by the graph' },
    );

    expect(otherConnection.safeAddress).toBe(safeAddress);
    expect(otherConnection.isIncoming).toBe(false);
    expect(otherConnection.isOutgoing).toBe(true);
    expect(otherConnection.limitPercentageIn).toBe(0);
    expect(otherConnection.limitPercentageOut).toBe(44);

    // Test bidirectional trust connections
    await core.trust.addConnection(otherAccount, {
      user: safeAddress,
      canSendTo: otherSafeAddress,
      limitPercentage: 72,
    });

    otherConnection = await core.utils.loop(
      () => {
        return getTrustConnection(
          core,
          otherAccount,
          otherSafeAddress,
          safeAddress,
        );
      },
      ({ isIncoming, isOutgoing }) => {
        return isIncoming && isOutgoing;
      },
      { label: 'Wait for trust connection to be indexed by the Graph' },
    );

    expect(otherConnection.safeAddress).toBe(safeAddress);
    expect(otherConnection.isIncoming).toBe(true);
    expect(otherConnection.isOutgoing).toBe(true);
    expect(otherConnection.limitPercentageIn).toBe(72);
    expect(otherConnection.limitPercentageOut).toBe(44);

    // This should not be true as we don't have enough
    // trust connections yet
    const { isTrusted } = await core.trust.isTrusted(otherAccount, {
      safeAddress,
    });

    expect(isTrusted).toBe(false);

    // This should be true as we lowered the limit
    const { isTrusted: isTrustedLowLimit } = await core.trust.isTrusted(
      otherAccount,
      {
        safeAddress,
        limit: 1,
      },
    );

    expect(isTrustedLowLimit).toBe(true);
  });

  it('should untrust someone', async () => {
    const response = await core.trust.removeConnection(account, {
      user: otherSafeAddress,
      canSendTo: safeAddress,
    });

    expect(web3.utils.isHexStrict(response)).toBe(true);

    await core.trust.removeConnection(otherAccount, {
      user: safeAddress,
      canSendTo: otherSafeAddress,
    });

    const network = await core.utils.loop(
      async () => {
        return await core.trust.getNetwork(account, {
          safeAddress,
        });
      },
      (network) => network.length === 0,
      { label: 'Wait for trust network to be empty after untrusting user' },
    );

    expect(network.length).toBe(0);
  });
});
