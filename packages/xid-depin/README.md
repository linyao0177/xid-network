# xid-depin

A toolkit for DePIN networks on the xid network. A project that rewards devices for sensing or serving somewhere (weather, air quality, energy) picks a template, changes what it needs, and deploys. The xid network does the rest:
- its compute nodes act as the network's oracles;
- its registry pays them and holds them to their word;
- its devices sign everything they report.

```sh
npx xid-depin templates
npx xid-depin new weather ./wx --name my-weather --epoch 86400
npx xid-depin deploy ./wx --testnet --key admin.key --budget 100 --mint
npx xid-depin keeper ./wx --home <a forwarding node's key> --key admin.key --claim
npx xid-depin status ./wx
npx xid-depin rewards ./wx 12
npx xid-depin audit ./wx 12
```

## What is in a network

| Piece | Where | What |
|---|---|---|
| `DepinNetwork` | [`contracts/DepinNetwork.sol`](contracts/DepinNetwork.sol) | The reward curve, enrollment, each epoch's rewards root, claims |
| `DepinToken` | [`contracts/DepinToken.sol`](contracts/DepinToken.sol) | A reward token the network mints as epochs are published (or bring your own and fund the contract) |
| The oracles' job | BoatRegistry | A compute job whose device is the network's key; its units are the network's epochs |
| The config | `config.json` | What is rewarded and how; its hash is fixed in the contract |
| Oracles | [`lib/oracle.js`](lib/oracle.js) | The boat-node plugin: follows devices, pings them, publishes evidence, scores, signs |
| Scoring | [`lib/score.js`](lib/score.js) | A pure function from the oracles' evidence to the rewards tree |
| Devices | [`lib/device.js`](lib/device.js) | A device in JS (gateways, simulations); ESP32s use [`components/boat_depin`](../../components/boat_depin) |

## One epoch

1. **Devices sign their data.**
    - Readings carry `ts`.
    - A join record (retained) names the device's H3 cell and its payee.
    - Over the radio, each device beacons once a slot and reports the beacons it heard.
2. **Oracles collect evidence.**
    - The oracles are the job's assigned compute nodes: quorum + spare, picked the same way by every node.
    - They follow every enrolled device and keep its messages.
    - Once a minute they ping each device and time its signed pong.
3. **Oracles publish what they hold.** After the epoch ends, each oracle publishes at the network's home node:
    - one *sheet* per device (the device's messages and the shortest round trip);
    - an *index* of the sheets' hashes, signed by its operator key.
4. **Oracles score and sign.**
    - Each oracle takes the other oracles' sheets and scores the epoch from all of them ([`lib/score.js`](lib/score.js)).
    - It signs `DepinNetwork.epochStatement(epoch, root, total, count)` as the result of the job's unit `epoch`.
    - It signs once, and keeps that on disk.
5. **The registry settles.** A quorum of the same result settles the unit on BoatRegistry. The oracles are paid from the job's budget, and enrollment fees top that budget up.
6. **Anyone publishes and claims.**
    - Anyone publishes the epoch on the network. `publishEpoch` checks that the registry settled exactly that statement, and that the total is within the curve's emission.
    - Anyone claims a device's reward with a Merkle proof. It goes to the payee the device named.

Two results for one epoch from the same oracle are double work, and `slashDoubleWork` takes half its stake. Anyone can re-run the score from the published sheets (`xid-depin audit`).

## The templates

A template is a config; `templates/` has three.

| | weather | air-quality | energy |
|---|---|---|---|
| Readings | `t`, `h`, `p` (°C, %, hPa, tenths) | `pm25`, `pm10`, `co2` | `mwh` (a meter, counting up), `w` |
| Epoch | 1 day, 288 slots | 1 day, 96 slots | 1 day, 96 slots |
| Score | uptime 60%, quality 25%, coverage 15% | uptime 50%, quality 40%, coverage 10% | the energy measured, capped by the rated power |
| Quality | every field within range | within range, and within 25 µg/m³ of the median around it | within range |
| Proof of coverage | beacons within 6 cells (res 8) | within 8 cells (res 9) | no |
| Area scaling | one station per res-7 cell earns in full | two sensors per res-7 cell | no |
| Curve | halving every 730 epochs, from 100,000 | exponential, 0.2% a day, floor 5,000 | steps: 20,000 for a year, 10,000 for two, then 2,000 |

## Reward curves

Both the contract (`emission`) and [`lib/curve.js`](lib/curve.js) compute these in integers, and they give the same amounts (test/curve.js).

| kind | emission of epoch e |
|---|---|
| `constant` | `initial` |
| `halving` | `initial >> (e / period)` |
| `exponential` | `initial × (1 − rate)^e`, rate in 1e18 |
| `linear` | `initial − rate × e`, down to 0 |
| `steps` | the amount of the first step with `e < until` |

`floor` is a tail emission that the curve never falls below. `end` is the epoch from which the emission is 0.

## Proof of location

- **The claim.** A device names its place in its join record as an H3 cell at the config's resolution. The record is signed with its own key and binds the device to the claim.
- **Round trips.**
    - Light in fibre covers about 200 km per ms. A round trip of *r* ms puts the device at most 100·*r* km from the oracle, whatever the path. Queues and hops only make the round trip longer.
    - A cell further from an oracle than its round trip allows (plus `slackKm`) is ruled out.
    - Oracles in many regions narrow a device down: a station that claims Berlin but answers an oracle in Taiwan within 4 ms is not in Berlin.
- **Lying oracles.** Two round trips that cannot both be true (their disks do not meet) are both left out. So an oracle that lies about a round trip cannot rule out a device that an honest oracle near it reaches. Its round trips are in its signed index.
- **Devices no oracle reached** earn nothing (`requirePing`, on by default).
- **The limits.**
    - A round trip can rule a place out, never in.
    - Within an oracle's reach (100 km per ms of round trip), the radio witnesses below place devices relative to each other.
    - A device's key in hardware (BoAT MER, a manufacturer's credential) is what makes a device one device.

## Proof of coverage

- **Beacons.** Devices beacon over the radio (ESP-NOW or BLE on an ESP32; `SimRadio` in simulations) once a slot. A beacon is signed by the device over the network, the slot and its key.
- **Witness reports.** Devices that hear a beacon report it with its signal strength.
- **When a witness counts:**
    - both devices are located;
    - they are within `rangeCells` of each other;
    - the signal is no stronger than free space allows over the shortest distance between their cells;
    - they are paid to different payees;
    - at most `maxWitnesses` per beacon count.
- **Covered slots.** A slot is covered when the device's beacon has `minWitnesses` valid witnesses.
- **Area scaling.** Devices that crowd one area (`coverage.hex`) share what `target` devices would earn.

## Evidence the oracles agree on

- **Majority.** A device's message counts only when most of the oracles' sheets hold it (more than half). One oracle can neither add readings, say late or backdated ones, nor drop any.
- **Deterministic.** Sheets are canonical JSON, and the score uses integers (and kilometres and dB rounded the same way everywhere). Every oracle that sees the same sheets signs the same root.
- **When oracles disagree.** An oracle waits for the sheets of every assigned oracle, up to `waitMs` after the epoch. If oracles ended up with different sheets, no quorum forms and the epoch stays unpublished. It is never published wrong.

## Running an oracle

Any boat-node with the compute role and the plugin is an oracle when the registry's plan assigns it a network's job:

```sh
sudo sh install.sh https://iot.xid.network/dl/node/boat-registry-0.1.0.tgz --testnet --depin 25.03,121.56
# or in node.json: "plugins": { "xid-depin": { "lat": 25.03, "lon": 121.56 } }
```

`lat, lon` is where the node is; its round trips are measured from there.

## Devices

A device publishes, signed with its own key (boat-mqtt-node's signed messages):

| Topic | Body |
|---|---|
| `d/<did>/<readings.topic>` | the config's fields, integers, and `ts` |
| `d/<did>/depin/<net>/join` (retained) | `{ v: 1, net, cell, payee, rated? }` |
| `d/<did>/depin/<net>/witness` | `{ v: 1, slot, heard: [{ from, slot, sig, rssi }] }` |
| `d/<did>/depin/<net>/pong` | `{ v: 1, nonce }`, the answer to `d/<oracle>/to/<did>/depin-ping` |

`xid-depin sim` runs simulated devices of a network's kind at given places, with a simulated radio between them.

An ESP32 station runs [`examples/depin_station`](../../examples/depin_station) (component [`boat_depin`](../../components/boat_depin)), whose beacons go over ESP-NOW. `xid-depin station` enrolls one and prints the line to type on its console:

```sh
xid-depin station <dir> --device <its key> --lat <lat> --lon <lon> --payee 0x.. [--key <file>]
```

## Tests

```sh
npm run test:sol   # forge: curves, enrollment and fees, publishing, claims
npm test           # curves JS = contract; scoring; a network end to end on a local chain
```

`test/e2e.js` runs a weather network on a local chain end to end:
- four boat-nodes;
- six stations: two that witness each other, three sharing an area, one claiming Berlin from Taipei, and one that never comes online.

Its checks:
- three oracles sign the same root;
- the epoch settles on the registry and is published on the network;
- the oracles are paid;
- a claim pays the payee.
