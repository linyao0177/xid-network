# boat-registry

The on-chain part of a network of MQTT nodes anyone can run ([`packages/boat-mqtt-node`](../boat-mqtt-node)), and `boat-node`, one program for a node in any of its roles.

Only what needs one global answer is on chain: who runs a node and with what stake, which work was settled and by whom, who is slashed, and who owns a device. Messages, storage, verdicts and computations stay off-chain, signed so they can be checked.

## The contract

[`contracts/BoatRegistry.sol`](contracts/BoatRegistry.sol), with an ERC-20 (a stablecoin) as stake.

- **Nodes** register a HyperDHT key, roles (forward, store, verify, compute) and a stake at or above the minimum. The stake comes back only after an unbonding period, and it can still be slashed meanwhile.
- **Slashing.**
    - Most chains cannot check Ed25519, the signature devices and nodes use on HyperDHT. So a statement a node can lose stake for is also signed with its EVM operator key (EIP-191).
    - **Equivocation:** two different roots signed for one batch. The contract checks it itself and takes half the stake.
    - **Two results for one unit** of a job: also checked by the contract itself (`slashDoubleWork`).
    - **Everything else:** a wrong verdict, a store that fails spot checks, a wrong bill. A quorum of the other verifiers signs the same judgement, and the contract counts the signatures.
    - **The quorum** is weighed by stake (own and delegated): 2/3 of the voting verifiers' stake, and two signers at least. A verifier votes only once it has been one for an epoch, so sybils that join in a hurry neither block a slash nor outvote anyone.
    - **The reporter** gets half of what the node itself loses (its own stake and unmatured rewards); the delegators' share goes to the treasury, so reporting oneself never pays. A node that falls below the minimum stake stops being active.
- **Delegation.** Anyone stakes on a node (`delegate`):
    - the delegators' part of its rewards, less the node's commission, compounds in the pool;
    - a new commission (at most 50%) applies only one unbonding period later;
    - slashes take from the node, the pool and stake that is leaving it (`undelegate`) in proportion, until the unbonding period is over;
    - once the node has withdrawn, its pool is no longer slashed.
- **Governance.** Once the admin calls `renounceAdmin`, issuers and the treasury change only by `govern`, signed by a quorum of verifiers as above.
- **Devices.** A device is claimed with two signatures:
    - a manufacturer's credential, an issuer's EIP-191 signature over the device's DID and wallet;
    - the device's own consent, its EIP-191 signature naming this owner, made on the device by BoAT MER's key.

## Running a node

```sh
npx boat-node init ./mynode --rpc <url> --registry 0x.. --roles forward,store,verify,compute
# fund the operator address it prints: gas, and the stake token
npx boat-node run ./mynode
npx boat-node status ./mynode
```

- **Keys.** `init` makes a seed and an operator key, mode 600, and prints neither.
    - The seed is the node's HyperDHT identity: the forwarding key it registers with and, derived from it, its store, verify and work keys.
    - The operator key holds the stake and signs the node's work.
- **Starting up.** `run` registers the node when it is not registered yet, with the minimum stake unless `stake` says more. It then puts its card in its HyperDHT record, a JSON naming the role keys and its operator.
- **Roles.** It runs only the ones it registered for:
    - **forward:** an MQTT node (boat-mqtt-node) under the registered key;
    - **store:** a Hypercore store for the devices of store jobs;
    - **verify:** work on verify jobs, the watchtower over every job, and the node list for devices;
    - **compute:** work on compute jobs.
- **Jobs and rewards.** It takes open jobs of its roles from the registry, settles units with the other nodes, and withdraws its rewards when they mature.
- **Status.** It writes `status.json` every minute and logs a line every 5 minutes. With `metricsPort` it serves Prometheus metrics on 127.0.0.1: stake, rewards, units signed and settled, faults, slashes, spot checks, reads.
- **Memory.** Every unit it signs is kept on disk, so a restart never signs one again with another result.
- **Production.** [`deploy/`](deploy) has a Dockerfile (build from `packages/`, run with host networking for UDP), a hardened systemd unit and `install.sh` (a system user, state in `/var/lib/boat-node`).

## Jobs and rewards

[`lib/work.js`](lib/work.js)

- **Posting.** Anyone posts paid work on a device's messages: `postJob(device, { role, quorum, perEpoch, deadline, spec, pay, budget }, params)`, with the budget in the stake token.
    - `params` is emitted only. For a compute job it holds the rule's WASM, and `spec` is its keccak256. Nodes take both from the `JobPosted` event.
    - `perEpoch` caps the units that settle in one epoch: a few bad nodes cannot drain a budget at once.
- **Devices pay for their own jobs.** An owner funds a device's balance on the registry (`fundDevice`). The device signs a job request with its BoAT MER key (`examples/boat_mer`, owner op `post_job`), and anyone relays it (`postJobFromDevice`, `examples/device-job.js`). The request carries a deadline and a nonce.
- **Units.** Nodes work unit by unit: a window of `window` sequence numbers of one boot. For each unit a node signs one result:

    | Role | Result |
    |---|---|
    | store | the root of the messages it holds, in a Hypercore others can spot-check |
    | verify | the root of its verdicts on them (replays and messages without the device's valid signature left out) |
    | compute | keccak(inputs, the rule's value) |
    | forward | keccak(forwarder, root of the messages): the node the device published to signs it, and verifiers that got the messages through that node witness it |

- **Publishing.** The node publishes the result retained at `d/<node>/work/<job>/<unit>`, with what it computed it from.
- **Settling.** A unit is settled once `quorum` active nodes of the job's role have signed the same result (`settle`), and they share its pay. A forward unit settles with the forwarder's signature and `quorum` witnesses (`settleForward`), and only the forwarder is paid.
    - Signers wait a few seconds for more signatures. Then the one with the lowest address submits, and the others do if it has not.
    - A settled verify root also proves any message's verdict: a Merkle proof against `settled(job, unit)`.
- **Rewards.** What a node earns in one epoch can be withdrawn after the next epoch has ended (`withdrawRewards`). A slash takes everything that has not matured yet.
- **Closing a job.** `closeJob` gives notice. Work keeps settling for `jobNotice`, and the next call after that returns the rest of the budget.

### Lost readings

A reading lost on the way leaves a unit short at a node. Once the next unit has started, the node asks the device's stores (the nodes assigned to its store jobs) for the missing sequence numbers. Each message comes back with the store's proof and the device's own signature, so a store can neither forge nor change one. Forward units are never filled this way: they count only what came through the node.

### Sealed readings

A device can seal its readings to its readers: the owner, and compute nodes by their work keys (`components/boat_device`, `boat-mqtt-node` `lib/sealed.js`).
- **How it works.** Readings are encrypted with a data key, and the key is sealed to each reader in an envelope at `d/<device>/keys/<id>`. Both are signed like any message.
- **Who sees what.** Verifiers and stores check and keep the ciphertext without reading it. Compute nodes holding the key bill from the plaintext, and a node without the key signs no bill.
- **Units.** A device has one counter for all its messages, so a compute unit counts every signed message towards its window and takes the job's readings in it as inputs.

## The watchtower

[`lib/watch.js`](lib/watch.js), run by every verifier node. Nobody has to step in.

| Fault | How it is found | Slashed by |
|---|---|---|
| double-work | two results signed for one unit | `slashDoubleWork`, checked by the contract (half the stake) |
| inconsistent | a result that is not what the message's own detail gives | quorum |
| wrong-value | a bill the rule does not give on its inputs | quorum |
| wrong-input | an input, leaf or verdict that a message the device signed contradicts; the evidence carries that message | quorum |
| store-failed | a store that signed for messages and then cannot show them in a spot check (a store that does not answer at all is not judged) | quorum |

- **Who works and who watches.** A job is worked on by quorum + 1 nodes of its role, and watched by 3 verifiers that judge its work and spot-check its stores. Both are the first by keccak(operator, device), so every job on a device lands on the same few nodes. A node follows only the devices it works on or watches, and a forwarding node follows a device only once the device publishes to it. The work around one device does not grow with the size of the network.
- **Raising a fault.** The verifier that finds one publishes it at `d/<node>/faults/<reason>`, with the evidence and its signature on the slash. It also sends the fault straight to every active verifier: each takes faults on its verify key (the fault mesh), since a slash needs a quorum of all of them and most do not follow the device.
- **Agreeing.** Every other verifier judges it again from the evidence alone, or with its own spot check, and adds its signature when it agrees. It reads the job from the chain if it does not watch it.
- **Slashing.** Once the signatures are a quorum (the contract is asked first, without a transaction), the one with the lowest address submits `slash`. A fault costs a fifth of the minimum stake, and the node's unmatured rewards go with it.
- **Spot checks.** One unit in 10 that a store signs is spot-checked, picked by keccak(job, unit, store): anyone can tell which, and a store cannot know ahead. Two of the job's watchers check it, the first two by keccak(watcher, job, unit).

## The node list

[`lib/nodelist.js`](lib/nodelist.js), and in C [`hdht_mqtt`](https://github.com/linyao0177/hyperdht-esp32/tree/main/components/hdht_mqtt) (`nodelist.c`, in hyperdht-esp32).

- **Publishing.** Every verifier puts a main record under its verify key: the verify keys of the 10 verifiers with the most stake, and the hashes of pages of forwarding nodes, most stake (own and delegated) first. Each page holds 28 nodes and is an immutable HyperDHT record stored under its own hash; there are up to 8 pages, 224 nodes. Verifiers that see the same registry put out the same bytes.
- **Choosing.** A device that trusts a set of verify keys takes the main record that a quorum of them (2 of 3) put out byte for byte, newest epoch first. It then reads one page, chosen by its own key so that devices spread over the nodes, and checks it against the hash.
    - It needs no chain, and no single verifier can send it to its own node.
    - When a list names other verifiers, the device trusts those next.
- **On the device.** `hdht_mqtt_nodelist_keep` (components/hdht_mqtt) does all of it: `examples/mqtt_p2p` (`CONFIG_MQTT_P2P_VERIFIERS`) and `examples/boat_mer` (`CONFIG_MER_MQTT_VERIFIERS`).

## Paid reads

[`contracts/BoatReads.sol`](contracts/BoatReads.sol), [`lib/reads.js`](lib/reads.js)

- **Terms.** A store sells the blocks it keeps. Its record says the price per block, the BoatReads contract and its operator.
- **Paying.** A reader opens a channel with a deposit, then signs with every block request how much it owes the store in all. The store serves while that sum grows by the price, and redeems the latest sum when it likes.
- **Closing.** The reader closes with notice. The store can still redeem during it, then the rest goes back. A reopened channel is a new generation: old vouchers are void.
- **Spot checks.** Index and head are free, and so are a few blocks per remote key and window.
- **In boat-node:** set `reads` and `readPrice` in `node.json`.

## Verifier nodes

[`lib/verifier.js`](lib/verifier.js)

- **Verdicts.** A verifier follows devices to their home nodes and gives each message a verdict: the device's own signature, replay, and a BoAT MER attestation when the message carries one.
- **Batches.** Every batch becomes a Merkle tree with keccak256 leaves (so a contract can check inclusion). The verifier signs the root (the signature is what it answers for; the root is not put on chain) and publishes the whole batch, retained at `d/<verifier>/batches/<n>`.
- **Checking.** Anyone checks a batch against the signed root (`checkBatch`) and gets a message's verdict with its proof (`verdictOf`). Another verifier that holds the same messages re-checks them (`auditBatch`).

## Compute nodes

[`lib/compute.js`](lib/compute.js)

- **Jobs.** A job names a WASM rule by its hash, a device, a field and a window. [`rules/energy-bill.wat`](rules/energy-bill.wat) is 148 bytes: integer arithmetic, no imports.
- **Running it.** Each compute node runs the rule on every window of the device's validly signed readings. Windows are fixed by sequence number, so all nodes bill the same readings. The node signs the result with its inputs.
- **Accepting a result.** Two of three must agree (`aggregate`). Anyone can rerun the rule on the published inputs (`checkResult`), so a wrong result is a judgement the verifiers can sign.

## Onboarding a device

[`examples/onboard.js`](examples/onboard.js) runs these steps against a BoAT MER device (`examples/boat_mer`) over its owner channel:

1. **Credential:** the manufacturer's credential.
2. **Consent:** the device signs its consent.
3. **Claim:** the owner claims the device on the registry.
4. **Funding:** the owner funds the device's wallet.
5. **Node:** the owner picks an active forwarding node from the registry that answers on HyperDHT. The device's new `mqtt_node` command moves it there, and the device names that node in its DID record.

## Pay-to-power

[`examples/pay-to-power.js`](examples/pay-to-power.js), with `examples/mqtt_p2p` built with `CONFIG_MQTT_P2P_METER`:

- The meter publishes signed energy readings, and three staked compute nodes bill them.
- A consumer pays each bill to the owner's wallet.
- The owner switches the meter's relay off when a bill goes unpaid and back on when it is paid. The meter takes relay commands only from its owner's key.

## Results (2026-11-08)

**Off-board** (local HyperDHT testnet and anvil): `npm test`.

| Suite | Checks |
|---|---|
| Contract | 9 of 9: registration, anchoring, equivocation, quorum slashing (no quorum, outsiders, order, replay), unbonding, device claims |
| Verifiers | 6 of 6: verdicts for good, forged, replayed and attested messages; batches anchored and checked; Merkle proofs; a changed batch refused; a verifier that lied caught by the other two and slashed |
| Compute | 6 of 6: 2 of 3 agree on the right bill; the wrong one shown wrong by a re-run and slashed |

**On the ESP32-C3:**

- **Onboarding** (`examples/boat_mer`):
    - Done in 26 s. The device signed its consent in 651 ms, and the claim took 208,341 gas.
    - The registry held a node that did not answer; the owner skipped it and chose the other one.
    - The device started MQTT on its owner's word and named that node in its record.
- **Pay-to-power** (`examples/mqtt_p2p` as the meter: a simulated 1,200 W load, a reading every 5 s, a bill every 6):
    - 6 bills of 2,082 base units (8.33 Wh at 0.25 per kWh). The compute node set to lie signed 6,246 each time, and the other two outvoted it.
    - When the consumer skipped bill 3, the owner switched the relay off and the next bill was 0 Wh. After payment it went back on. The owner received 10,410 base units.
    - The meter refused a stranger's relay command.
- **Public network** (a node on the GCP VM in Taiwan, the board and the Mac in China):
    - The device found the cloud node and connected directly (no relay) in 9.9 s.
    - Commands round trip: median 456 ms with the app on the VM, 777 ms with the app on the Mac, against a ping of about 350 ms with 25% loss on that path.
    - When the cloud node stopped, the device noticed after 18 s (its goodbye was lost on the way) and was on the Mac's node 18 s later.

## Iteration 2 results (2026-11-09)

**Off-board** (`npm test`):

| Suite | Checks |
|---|---|
| Contract | 13 of 13; new: settling by quorum and role, rewards that mature an epoch later, double work, closing a job |
| Node list in C | 8 of 8; the tally in `nodelist.c` matches the JS: quorum, newest epoch, cut records, a full list |
| `boat-node` | 22 of 22 |

The `boat-node` test runs six nodes on a local chain with three jobs on one meter:
- **Honest work.** Units of all three jobs settled. Honest nodes were paid and withdrew once their rewards matured.
- **Dishonest nodes.** The watchtowers slashed all three with no one stepping in:
    - a compute node that signed bills three times too high (wrong-value);
    - a verifier that claimed an attestation the device's message did not carry (wrong-input);
    - a store that dropped what it signed (store-failed, with its unmatured rewards).
- **Re-judging.** A verifier that did not see the messages agreed from the evidence alone. It disagreed when the evidence was changed, or when the accused node was honest.
- **Double work.** Two results for one unit were slashed by the contract itself.
- **Node list.** It was agreed 3 of 3, without the slashed nodes. A single verifier's forged list was refused.
- **Proof.** A message's verdict was proven against the root settled on chain.
- **Closing.** A closed job returned its budget.

**Arc testnet** (chain 5042002):
- **Contracts.** Registry `0x5786b09bD1854Cb681597D3116f2a47088D7a70d`, test stake token `0x522B17429803C840855936466B2D7F5947D48e0D`; minimum stake 100, epoch 1 h, unbonding 1 day.
- **Nodes.** Three nodes in all four roles: one on a GCP VM in Taiwan, two on a Mac in China. A fourth node signs wrong bills on purpose.
- **Device.** The ESP32-C3 runs `examples/mqtt_p2p` as the meter: a reading every 30 s, a unit every 20 readings.
- **Node list.** The board read the three verifiers' records and took the list two of them agreed on (the third was still out of date): 3 nodes. It connected directly in 1.6 s. When that node restarted, it reached another listed node 14 s later.
- **Slashing.** The dishonest node's first wrong bill was found by the watchtower on the GCP node and slashed 4 s later on Arc (a fifth of its stake), which made it inactive. No one stepped in.
- **Settling.** Each unit settles with 3 signers for 120,800 gas, about 0.003 test USDC at 25 gwei.
- **What the first run found.** Two things that a local chain never showed:
    - A node sending several transactions at once (three settles and a slash) gave two of them one nonce.
    - The public RPC sometimes fails a read, and a revert comes back without its reason.

  Nodes now queue their own transactions, retry reads, retry a settle, and look at the chain to tell "settled by someone else" from a failure.
- **The second run** found a firmware bug, not a network one.
    - **What happened.** About an hour in, the Wi-Fi router dropped for a few minutes (03:30, UTC+8). ESP-IDF's example Wi-Fi helper, which `mqtt_p2p`, `boat_mer`, `app_template`, `minimal` and `hyperdht_demo` use, gave up after 6 tries and stayed offline for 3.7 hours, although the network was back.
    - **The fix.** Their `sdkconfig.defaults` now set `CONFIG_EXAMPLE_WIFI_CONN_MAX_RETRY` so they keep trying; `uart_module` has its own handler and already did.
    - **Checked on the board** with an access point gone for 5 minutes. When it came back: Wi-Fi in 2 s, an IP in 3 s, MQTT on its node 6 s later. Telemetry and receipts resumed, and HyperDHT recovered without a restart.
    - **The Mac's proxy.** The Mac nodes reach the Arc RPC through a local proxy, which failed for 3.5 hours over the same night. They retried and came back; the GCP node needs no proxy.
- **24-hour run.** The third run started at 2026-11-09 08:05 (UTC+8), with the node the meter is on stopped for 10 minutes at hours 3 and 12. Its results come here once it ends.

## Iteration 3 results (2026-11-09)

| Suite | Checks |
|---|---|
| Contract, iteration 3 (`test/v3.js`) | 20 of 20. Forward settlement; job rate; delegation with compounding, commission notice and slashes in proportion; devices' own jobs; governance; paid reads. Each attack the review found is shown failing |
| Invariants (`npm run test:sol`, Foundry) | 3 of 3. 500 runs × 150 random steps (75,000 calls each), mixing registration, delegation, undelegation, settles, quorum slashes, self-reports, closing, withdrawing and time. Throughout, the tokens held equal the tokens owed, total stake is own plus bonded pool, and nobody gains by reporting itself |
| Paid reads (`test/reads.js`) | 5 of 5 |
| Node list in C (`test/nodelist-c.js`) | 11 of 11, paged; HyperDHT immutable get in C checked against JS on the public DHT |
| `boat-node` end to end (`test/node.js`) | 25 of 25, with a forward job and metrics |

- **Independent review.** A separate agent, given only the code, found three high and three medium issues, four of them confirmed with Foundry tests, and some low ones:
    - **High:**
        - a node could report itself and take half of its delegators' stake;
        - delegators could undelegate ahead of a slash;
        - sybil verifiers could block slashes or take the treasury.
    - **Medium:**
        - a slash after withdrawal hit only delegators;
        - a few nodes could drain a job;
        - commission changed instantly.
    - **Low:** old read vouchers after reopening; device requests without expiry; a restart re-signing a unit.

  All are fixed and covered by `test/v3.js` or the invariants. The contract is built with via-IR; it is 20.9 KB.
- **Scale** (`bench/scale.js`): boat-nodes, each its own process, and meters each sending a signed reading a second, with jobs on every meter, all on one Mac (M4, 10 cores, 16 GB), with a local chain and a local HyperDHT testnet. Each run is 2 to 5 minutes.

    | Nodes, meters, jobs | Settled | Per second | Latency (p50 / p99) | CPU per node |
    |---|---|---|---|---|
    | 12, 100, verify + compute (200), first version | 2% | 0.7 | 225 s / 721 s | one process, saturated |
    | the same, after the fixes below | **100%** (11,800 units) | **37** | **3.0 s / 11 s** | **7%** |
    | 24, 100, verify + compute (200) | **100%** | **34** | **1.9 s / 4.3 s** | **2%** |
    | 24, 200, verify + compute (400) | **99%** | **67** | 9 s | |
    | 24, 200, all four kinds (800) | 25% | 37 | 51 s | 22% |

    What it took. Each change was found by a run that did not keep up:
    - **Assignment.** A job is worked on by quorum + 1 nodes of its role, not by every node; its units are judged by 3 watchers. Both are picked by device, so a device's jobs land on the same few nodes.
    - **Fan-out.** Work is published at the device's home node only. Each node subscribes once per home node, not once per job, and a forwarding node follows a device only once it publishes there. Faults go to every verifier directly over the fault mesh.
    - **Signatures.** They are checked when a group is about to settle or be judged, not for every message, and settlements are spread over the signers by rank.
    - **The chain.** RPC connections are kept alive, lookups in flight are shared, and units settle in batches (`settleMany`, about 20 units a transaction).
    - **Spot checks.** One store unit in 10 is spot-checked, not every one.

    The last row was the limit of the nodes themselves, not of the machine or the protocol: see "Scale across machines" in iteration 4.

## Iteration 4 (2026-11-09)

- **Lost readings** are fetched from stores.
    - In the end-to-end test, a node that lost one reading in 7 fetched 30 and signed as many units as the others.
    - In the scale test (24 nodes, 200 meters, four kinds of job), settlement rose from 25% to 33% of units, 49 a second.
- **Scale across machines** (`bench/cluster.js`): a chain machine and three node machines on GCP (e2-standard-4: 4 vCPUs, 16 GB), four kinds of job on every meter, a reading a second from each, 5 minutes.

    | Nodes (a machine), meters | Settled | Per second | Latency (p50 / p99) | CPU per node |
    |---|---|---|---|---|
    | 24 (8), 200, before the fixes below | 18.6% | 28 | 124 s / 262 s | |
    | 24 (8), 200, after them | 37.9% | 57 | 95 s / 216 s | 49% of a vCPU: the machines were full |
    | 12 (4), 100, after them | **99.7%** (23,536 units) | **75** | **7.0 s / 23 s** | 85% of a vCPU |

    The last two rows give each node the same work (about 100 jobs it works on and as many it watches). With room on the machine, every unit settles within seconds; 8 nodes on 4 vCPUs fall behind and never catch up. On one Mac (24 nodes, 200 meters, 3 minutes) the same fixes took settlement from 28.6% to 57.9%. The Mac has 10 cores for 24 nodes, the chain and the meters.

    What held the nodes back, found from node logs (`work:`, `settler:` and `loop:` lines every 15 s), timestamps on work messages and CPU profiles of a node:
    - **Signature checks.** Recovering a secp256k1 signer in JS takes a millisecond or two, and a node did it for nearly every work message it saw:
        - watchers checked each message's signature before judging it;
        - every node that saw a quorum checked all signatures before working out who submits;
        - a backup checked them before asking the chain whether the unit had settled.

      Now a node keeps each answer, ranks submitters by the signers that messages claim, and checks signatures only when it submits, finds wrong work or spot-checks. A node's busy time fell from 46% to 33% of its run, and signature recovery from 21% to 6.5%. While the nodes were behind, their event loops stalled for 0.5 to 1.4 s (p99) and work messages took 15 to 60 s to be handled, so quorums formed late.
    - **One transaction at a time.** A node waited for each batch's receipt before sending the next, which made it the slowest step, and backups then sent the same units again. A batch now holds the node's transaction queue only until it is sent.
    - **Units forgotten.** The settler kept only its last 2,000 units: half a minute at this load, less than a backup's wait. It now forgets settled units after a minute and others after an hour.
    - **Measurement.** `ps` gives Linux processes' CPU as an average over their whole life, idle registration included, so the earlier runs showed 20% where nodes used all they could get. The benches now use CPU time over each 15 s.

  CPU goes with the rate of messages. At a reading every 30 s, as the economics below assume, a node's share of 100 devices would take about 3% of a vCPU. The rest of a node's time is spread over MQTT, judging work and garbage collection. A native secp256k1 library would take most of what remains of signature checks.
- **Sealed readings** (`test/sealed-node.js`, 5 of 5): bills on sealed readings settled with the right value, the node that was not a reader signed none, and every node verified them. The C and the JS seal and open each other's (`boat-mqtt-node test/sealed.js`, 5 of 5).
- **`components/boat_device`** and `examples/boat_device_min` (builds; not yet on the board).
- **Arc testnet**, the iteration 3 contract staking real testnet USDC (`0x3600000000000000000000000000000000000000`), with a minimum stake of 1 USDC:
    - registry `0xCf0977882e057297891402C7a985E35569d63d5f`;
    - BoatReads `0xdBC9B9567E0B8034e0f1BA1452B371E2912d221e`.

  A first job's budget went in and out as USDC. Nodes move to it after the 24-hour soak.
- **Economics** (`bench/economics.js`).
    - **Today:** settling every unit on chain would cost a device about $42 a month at Arc's gas price, 99% of it gas.
    - **Proposed:** settling one Merkle root per node an hour would bring it to about $1.50.
- **Dashboard.** `examples/snapshot.js` reads a deployment into JSON files for the network's dashboard.

## Not yet

- **Network tests:** a test over 4G (it needs a hotspot) and with nodes outside this network.
- **Hardware:** a real meter and relay; the meter here is simulated in firmware.
- **Staking token.** It is a test token; a real one would be a stablecoin.
- **Contract on Arc.** The Arc testnet still runs the iteration 2 contract; iteration 3 has run on local chains only.
- **Quorum gas.** The weighted quorum walks every verifier: fine for tens of verifiers, not for thousands (an epoch snapshot would fix it).
- **A forward unit needs one node.** A unit whose messages went through two nodes (the device moved) is not paid to either.
- **No audit.** The contract has been reviewed by an agent and fuzzed, not audited.
- **Assignment is checked after the fact.** The contract pays any `quorum` active nodes of a job's role; who was assigned is computed off-chain. It names the signers of each settlement (`SettledBy`), and the watchers slash one that was not assigned ([`lib/audit.js`](lib/audit.js), `test/audit.js`), but the unit's pay has left the job by then. On a registry deployed before `SettledBy`, the signers are read from the settling transaction, which only works when it called the registry directly.
- **Contract size.** `BoatRegistry` is 17 bytes under the 24,576-byte limit: the next addition needs something moved out (a library, or the device claims).
- **Epoch roots.** Settlement is still one unit at a time (in batches); the economics say it should be one root per node an hour.
