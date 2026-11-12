# xid network docs

xid network is an open network for connected devices. Devices sign everything they send. Independent nodes, run by anyone who puts up a stake, carry that data, store it, check it and bill it. A smart contract pays them only when enough of them agree, so nobody in the middle has to be trusted.

## Pick your path

Four kinds of people use xid network. Find yours and go to its chapter. Anyone can join the [public testnet](#testnet) in a few minutes, with a board or without one, or run the whole network on one laptop in the [Quick Start](#quick-start).

| You are | You want to | What you get | Read |
| --- | --- | --- | --- |
| A device maker | Ship devices whose data people can rely on | Devices with their own identity, no cloud account, no server to run | [For device makers](#for-device-makers) |
| A node operator | Earn by running part of the network | Pay for every unit of work you and your peers agree on | [For node operators](#for-node-operators) |
| An app or a buyer of data | Use device data and pay for it fairly | Data you can check yourself, paid only when nodes agree | [For apps and buyers](#for-apps-and-buyers) |
| A DePIN project | Reward devices for sensing or serving somewhere: weather, air quality, energy | Reward curves, proof of location and proof of coverage as templates; the network's nodes as your oracles | [For DePIN networks](#depin) |

## How xid network works

![Devices sign, staked nodes check each other, the chain pays for agreed work](img:glance)

A device talks to one node at a time, over the internet, from behind any router. That node passes its data to the other nodes working on it, and they check each other. The contract on chain only keeps score: who has staked, which work was agreed, who gets paid and who lied.

## Download {#download}

Everything needed to try the network without building anything: firmware for the ESP32-C3, the node software and checksums. Version 0.1.0, built 2026-11-11. Checksums: [SHA256SUMS](https://iot.xid.network/dl/SHA256SUMS).

### Firmware for the ESP32-C3

Install it from this page in Chrome or Edge on a computer: plug the board in by USB, press the button and pick its port. The installer erases the board, writes the firmware and, for `boat_device_min`, asks for your Wi-Fi. `boat_device_min` then joins the [public testnet](#testnet) on its own.

<script type="module" src="https://unpkg.com/esp-web-tools@10.0.1/dist/web/install-button.js?module"></script>
<div class="install">
<esp-web-install-button manifest="https://iot.xid.network/dl/firmware/boat_device_min.manifest.json"><button slot="activate" type="button" class="install-btn">Install boat_device_min</button><span slot="unsupported" class="install-note">To install from the browser, open this page in Chrome or Edge on a computer.</span><span slot="not-allowed" class="install-note">The installer needs this page over HTTPS.</span></esp-web-install-button>
<esp-web-install-button manifest="https://iot.xid.network/dl/firmware/uart_module.manifest.json"><button slot="activate" type="button" class="install-btn line">Install uart_module</button><span slot="unsupported"></span><span slot="not-allowed"></span></esp-web-install-button>
</div>

| Firmware | What it is | Wi-Fi | File |
| --- | --- | --- | --- |
| boat_device_min | The smallest BoAT device: a signed reading every 10 seconds, and the nodes' receipts checked on the device | The installer asks for it (Improv) | [boat_device_min-esp32c3-0.1.0.bin](https://iot.xid.network/dl/firmware/boat_device_min-esp32c3-0.1.0.bin) |
| uart_module | The C3 as a network module that a host microcontroller drives with AT commands over USB ([commands](https://github.com/linyao0177/hyperdht-esp32/blob/main/docs/module-uart.md)) | The host sets it with `AT+WIFI` | [uart_module-esp32c3-0.1.0.bin](https://iot.xid.network/dl/firmware/uart_module-esp32c3-0.1.0.bin) |

Each file is the whole flash image, written at address 0. Without the browser, use esptool:

```bash
esptool.py --chip esp32c3 erase_flash
esptool.py --chip esp32c3 write_flash 0x0 boat_device_min-esp32c3-0.1.0.bin
```

The images use the C3's built-in USB port for the console. That is the port on most small C3 boards; on a board whose USB socket goes through a USB-to-UART chip, build the firmware yourself with the console on UART0.

`boat_device_min` takes these settings on its console (the installer's **Logs & console**, or any serial terminal at 115200 baud). It keeps them across restarts and restarts to use a new one:

| Command | Sets |
| --- | --- |
| `boat network <name>` | The network to look up when it has no verifiers (default `xid-testnet`) |
| `boat verifiers <key>,<key>,…` | The verify keys whose node list it trusts, as `boat-node init` prints them (default: the testnet's four) |
| `boat readers <key>,<key>,…` | Keys that may read its readings: with readers set, readings are sealed |
| `boat show` | Prints what it uses now and its device key |

A command with no value goes back to the default.

### Node software

```bash
npm install -g https://iot.xid.network/dl/node/boat-registry-0.1.0.tgz
```

This installs `boat-node`, the simulated devices of `boat-sim` and the quick start's helpers, with Node.js 20 or later; [For node operators](#for-node-operators) says how to run a node. The package pulls in three others from the same place: [boat-mqtt-node](https://iot.xid.network/dl/node/boat-mqtt-node-0.1.0.tgz), [boat-peer](https://iot.xid.network/dl/node/boat-peer-0.1.0.tgz) and [boat-ota](https://iot.xid.network/dl/node/boat-ota-0.1.0.tgz).

Apps that follow devices need only the client tools, `boat-watch` and `boat-read-store` ([For apps and buyers](#for-apps-and-buyers)):

```bash
npm install -g https://iot.xid.network/dl/node/boat-mqtt-node-0.1.0.tgz
```

### Source

Two repositories on GitHub, under the MIT license: [xid-network](https://github.com/linyao0177/xid-network) has the nodes, the contracts, the device components and `boat_device_min`, and this site; [hyperdht-esp32](https://github.com/linyao0177/hyperdht-esp32) has HyperDHT in C for the ESP32-C3, MQTT over it, and the `uart_module` firmware. Clone xid-network with `--recursive`: it uses hyperdht-esp32 as a submodule.

## Public testnet {#testnet}

A network that is always on, for trying xid network with others: four nodes in four regions, contracts on Arc testnet, and a page that shows it live at [iot.xid.network/network](https://iot.xid.network/network/). Stake and job budgets are in TSUSD, a test token anyone can mint, so the only thing with a cost is gas, in Arc's testnet USDC.

| Part | Where |
| --- | --- |
| Nodes | `xid-us` (Iowa), `xid-eu` (Belgium), `xid-tw` (Taiwan), `xid-jp` (Tokyo): forward, store, verify and compute, 100 TSUSD staked each |
| Chain | Arc testnet (chain id 5042002), RPC `https://rpc.testnet.arc.network`, [explorer](https://testnet.arcscan.app) |
| Contracts | Registry `0x26Ae7fCe8FBB4cAcE6778eC00a4EfFe785D83329`, TSUSD `0xB274c18eb5ff5F06be97C8C6dFc9A70916f194E8` |
| Network name | `xid-testnet` |
| Everything above, for programs | [testnet.json](https://iot.xid.network/testnet.json) |

It is a testnet: what devices publish there is public unless they seal it, the contracts may be replaced, and nothing on it is worth money.

### Put a board on it

1. Install `boat_device_min` from the [download section](#download) and give it your Wi-Fi when the installer asks.
2. Open **Logs & console** and type `boat show`. It prints the device key: `BOAT|config network=xid-testnet verifiers=4 … device=<key>`.
3. Paste the key under **Flash a device** on the [testnet page](https://iot.xid.network/network/) and press **Sponsor**. The testnet posts a verify job and a store job on the device's readings, 500 units each, and pays the nodes for them.

The device shows under **Devices** within a minute; its first units settle after about 20 minutes (a unit is 20 readings, and units settle on chain six at a time).

### No board

`boat-sim` runs devices that sign their readings the way the firmware does. With `--testnet` it spreads them over the testnet's nodes and asks the testnet to sponsor each one:

```bash
npm install -g https://iot.xid.network/dl/node/boat-registry-0.1.0.tgz
boat-sim --testnet --devices 3
```

Their keys stay in `~/.boat-sim`, so a second run is the same devices. Run one `boat-sim` per key directory: two clients with one device key push each other off the node (`connection reset by peer`); give a second run its own `--dir`. To see what any device publishes:

```bash
boat-watch --network xid-testnet --filter 'd/+/telemetry' --seconds 120
```

### Run a node on it

A Linux machine with Node.js 20 or later, systemd, and outbound UDP:

```bash
curl -fsSL https://iot.xid.network/dl/node/install.sh | sudo sh -s -- \
  https://iot.xid.network/dl/node/boat-registry-0.1.0.tgz --testnet --no-start
```

`--testnet` takes the chain, contracts and network name from `testnet.json`. The installer prints the node's operator address. Paste it under **Run a node** on the [testnet page](https://iot.xid.network/network/) for 1,000 TSUSD and 0.1 USDC of gas, then start it:

```bash
sudo cp /opt/boat-node/boat-registry/deploy/boat-node.service /etc/systemd/system/
sudo systemctl enable --now boat-node
journalctl -u boat-node -f
```

It stakes 100 TSUSD, registers, and starts taking work. Settling uses gas, about 0.0025 USDC a transaction (a batch of units); with today's traffic a node spends around 1.5 USDC a day. For more than the faucet gives, get Arc testnet USDC at [faucet.circle.com](https://faucet.circle.com). The node shows on the testnet page as a community node.

### Pay for your own jobs

Anyone can post jobs on any device. `boat-post-jobs` mints the budget in TSUSD itself, so the wallet in `my.key` (a private key in hex) needs only gas:

```bash
boat-post-jobs --rpc https://rpc.testnet.arc.network --registry 0x26Ae7fCe8FBB4cAcE6778eC00a4EfFe785D83329 \
  --key-file my.key --device <device key> --only verify,store
```

### Limits

The faucet gives each address once a day, and each client three times; the testnet sponsors each device once a day, and five per client. Both stop for the day after 100 drips and 200 sponsorships.

## Quick Start {#quick-start}

Whichever path you take, this is the fastest way to see every part working. In about 15 minutes you run the whole network on one laptop: a chain, three staked nodes, a meter that signs its readings, jobs that pay for verifying, storing and billing them, and a fourth node that lies and loses its stake. Every output below is from a real run on 2026-11-09; your keys and addresses will differ.

![What you will run: one chain, four nodes and one meter on your laptop](img:setup)

The nodes and the meter find each other through the public HyperDHT, exactly as they would on separate machines; only the chain is local.

### 1. Install

You need Node.js 22 and Foundry (for `anvil`, a local chain). The nodes find each other over the public HyperDHT, so you also need an internet connection; no port forwarding.

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
npm install -g https://iot.xid.network/dl/node/boat-registry-0.1.0.tgz
mkdir -p ~/xid-quickstart
```

The package gives five commands: `boat-node` runs a node, and `boat-deploy`, `boat-fund`, `boat-meter` and `boat-post-jobs` are this quick start's helpers. Everything there is to download is under [Download](#download).

### 2. Start a chain

In a second terminal, start `anvil` and leave it running. It prints ten funded test accounts; copy the first private key into `~/xid-quickstart/admin.key`. That account deploys the contracts and pays for the jobs.

```bash
anvil --port 8555
```

### 3. Deploy the contracts

`boat-deploy` deploys a test stake token, the registry and BoatReads. `--epoch 60` makes an epoch one minute long, so new verifiers start counting after a minute instead of an hour.

```bash
Q=~/xid-quickstart
boat-deploy --rpc http://127.0.0.1:8555 --key-file $Q/admin.key --epoch 60 --notice 60 --out $Q/deployment.json
```

```text
"token": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
"registry": "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
"reads": "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
"minStake": "100000000",
"epochLength": "60"
```

On a fresh `anvil` the addresses are always these.

### 4. Start three nodes

Each node gets its own directory with a seed and an operator key. `init` prints the operator address to fund, the node key (where devices connect) and the verify key (what devices trust for the node list). `boat-fund` sends each operator 1.5 test ETH for gas and 200 test tokens to stake.

```bash
REG=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
TOK=0x5FbDB2315678afecb367f032d93F642f64180aa3
for n in n1 n2 n3; do
  boat-node init $Q/$n --rpc http://127.0.0.1:8555 --registry $REG --network xid-quickstart | tee $Q/$n.init
  boat-fund --rpc http://127.0.0.1:8555 --key-file $Q/admin.key --token $TOK --to $(awk '/operator/{print $2}' $Q/$n.init)
  boat-node run $Q/$n > $Q/$n.log 2>&1 &
done
```

```text
operator 0x82b3999080C76e82dd0c63EbAa8CFF79A804064E
node key 8b2c7fb03ba25e8c7064bec842f6838f772230e8ec6db5cd36a011f8567a3698
verify key f1d88bd63cd6f417244ac6a699435a34db8c39c4aa2fdb50d3d6c224304d84ce
0x82b3…064E: gas 1.5, stake token 200000000; funder has 9998.49 left
```

Within a minute each node's log shows it registered, staked 100 tokens and published the node list:

```text
10:46:39 registered: roles 15, stake 100000000
10:46:48 forwarding as 8b2c7fb03ba25e8c7064bec842f6838f772230e8ec6db5cd36a011f8567a3698
10:47:00 storing as c38c2b259856b80ac7d1a2b424497e438baca030a054e6afceef8717810163e7
10:47:19 node list for epoch 29903686: 3 node(s) on 1 page(s), 3 verifier(s)
```

Roles 15 means all four roles (1 + 2 + 4 + 8).

### 5. Connect a meter

`boat-meter` behaves like the ESP32-C3 meter firmware: its own key, a signed reading every 2 seconds, its home node named in its DHT record. Point it at the first node's key.

```bash
boat-meter --node $(awk '/node key/{print $3}' $Q/n1.init) --key $Q/meter.key > $Q/meter.log &
```

```text
10:47:22 meter b2a18d55d92a8a76da765e323c0ffc45ad3d0b5ae253fe4827602d09212422f8
10:47:22 home node 8b2c7fb03ba25e8c…, publishing every 2 s
```

The long hex string is the device key. Jobs name the device by it.

### 6. Post jobs

`boat-post-jobs` posts three jobs on the meter, paid by the admin account: verify every message, store the history and bill the energy with the WASM rule. A unit is 5 readings; each unit pays 1 token, split among the nodes that signed it.

```bash
DEV=$(awk '/meter/{print $3}' $Q/meter.log)
boat-post-jobs --rpc http://127.0.0.1:8555 --registry $REG --key-file $Q/admin.key --device $DEV --window 5
```

```text
{"verify":0,"store":1,"compute":2}
```

### 7. Watch units settle

Nodes pick up the jobs within seconds and the first units settle well under a minute later. A unit is named `<boot>:<window>`; `2 signers` means a quorum of two nodes signed the same result.

```text
10:47:38 working on job 0: verify b2a18d55d92a…, window 5, pay 1000000, quorum 2
10:47:41 working on job 1: store b2a18d55d92a…, window 5, pay 1000000, quorum 2
10:47:43 working on job 2: compute b2a18d55d92a…, window 5, pay 1000000, quorum 2
10:48:08 settled job 2 unit 1794221242:3: 2 signers, 215972 gas (a batch of 2)
10:48:28 settled job 1 unit 1794221242:5: 3 signers, 112513 gas (a batch of 3)
10:48:48 settled job 0 unit 1794221242:7: 3 signers, 112652 gas (a batch of 3)
```

Ask the registry what a node has earned:

```bash
boat-node status $Q/n1
```

```text
"active": true,
"stake": "100000000",
"rewards": { "pending": "3166664", "matured": "0" },
"jobs": "3"
```

3.17 tokens after about a minute of work. Rewards mature after an epoch, and the node withdraws them on its own.

### 8. Catch a liar

A slash needs more than two thirds of the verifiers' stake, so add a fourth honest node first. Then restart the third node with `testLie`, which makes it sign energy bills three times too high.

```bash
boat-node init $Q/n4 --rpc http://127.0.0.1:8555 --registry $REG --network xid-quickstart | tee $Q/n4.init
boat-fund --rpc http://127.0.0.1:8555 --key-file $Q/admin.key --token $TOK --to $(awk '/operator/{print $2}' $Q/n4.init)
boat-node run $Q/n4 > $Q/n4.log 2>&1 &
# stop n3 (its process), add  "testLie": "compute"  to $Q/n3/node.json, then:
boat-node run $Q/n3 >> $Q/n3.log 2>&1 &
```

The watchers recompute its bills, agree on a fault and slash it on chain:

```text
10:50:12 FAULT wrong-value by 0xb0dc12B5… job 2 unit 1794221242:16
10:50:13 SLASHED 0xb0dc12B5… for wrong-value, tx 0x216e42c608…
10:50:20 SLASHED 0xb0dc12B5… for wrong-value, tx 0x4edcf17a87…
```

```text
$ boat-node status $Q/n3
"active": false,
"stake": "40000000",
"rewards": { "pending": "0" }
```

The liar lost 60 of its 100 tokens and its pending rewards, and with less than the minimum stake it gets no more work. The honest nodes kept settling the whole time.

![The Quick Start run: paid 89 s after the nodes joined; a liar slashed 36 s after it came back](img:timeline)

The whole run, from three empty nodes to a paid unit and a slashed liar, took under four minutes.

### 9. Clean up

Stop the processes you started (the node, meter and `anvil` jobs in these terminals) and remove `~/xid-quickstart`. Stop them by the paths you used, so you do not stop other nodes on the same machine.

### 10. The same with an ESP32-C3

Replace the simulated meter with a board. The quickest way needs no ESP-IDF: install `boat_device_min` from [Download](#download) in Chrome or Edge and give it your Wi-Fi when the installer asks. Then, in the installer's **Logs & console**, point it at your nodes:

```text
boat network xid-quickstart
boat verifiers <the three verify keys that init printed, separated by commas>
```

It restarts after each setting, reads the node list from your verifiers and connects to one of your nodes. `BOAT|device <key>` is its device key, and every reading shows how many receipts the nodes sent. Post verify and store jobs for that key as in step 6. Its readings carry no energy figure, so for the energy bill use the meter firmware below.

To build the meter firmware, `examples/mqtt_p2p`, you need ESP-IDF 5.x and the [source](#download):

1. In `idf.py menuconfig`, set your Wi-Fi under Example Connection Configuration, turn on `MQTT_P2P_METER`, and set `MQTT_P2P_VERIFIERS` to the three verify keys that `init` printed, separated by commas.
2. Build and flash:

   ```bash
   cd examples/mqtt_p2p
   idf.py set-target esp32c3
   idf.py -p <serial port> flash monitor
   ```
3. The board reads the node list from your verifiers, connects to one of your nodes and prints its device key. Post jobs for that key as in step 6.

The board signs each reading in about 21 ms and takes 5 to 8 seconds to find a node and connect.

## For device makers

Build xid network into your firmware and every device you ship gets its own identity, sends data that anyone can verify, and needs no cloud account or server from you.

### What you get

- **An identity per device.** Each device makes its own key pair on first boot. The public key is its address on the network and its ID (`did:mw:<key>`). No account, no password, no server address in the firmware.
- **No servers to run.** Devices find staked nodes by themselves and connect from behind any router or NAT. When a node goes away, a device is on another one in 14 to 16 seconds.
- **Data people can rely on.** Every message is signed on the device, in 21 ms on an ESP32-C3. A node, an app or an auditor can check that it came from that device, unchanged, whatever path it took.
- **Privacy when you need it.** A device can seal its readings so that only readers it names can open them. Nodes still check and store them without seeing inside.
- **Paid services on demand.** Anyone who needs your devices' data verified, stored or billed posts a job and pays the nodes for it. A device can even fund its own jobs.

### What you need

| | |
| --- | --- |
| Chip | ESP32-C3. Other ESP32 chips have not been tested yet. |
| Firmware | ESP-IDF 5.x and the `boat_device` component |
| Connectivity | Wi-Fi with internet access. Cellular has not been tested yet. |
| Trust anchor | The keys of three verifiers you trust, for the node list. The device trusts a list of nodes only when 2 of the 3 signed the same one. |

### Put a device on the network

1. Add `components/boat_device` to your project, together with `hdht` and `hdht_mqtt` from [hyperdht-esp32](https://github.com/linyao0177/hyperdht-esp32) (in xid-network, the `third_party/hyperdht-esp32` submodule), which it uses.
2. Start it once Wi-Fi is up, and publish:

   ```c
   boat_device_config_t cfg = {
     .nvs_namespace = "my_dev",
     .verifiers = "<verify key>,<verify key>,<verify key>",
     .readers = "<owner key>",       // optional: who may open sealed readings
     .on_message = on_message,        // optional: commands sent to the device
   };
   boat_device_start(&cfg);
   boat_device_publish("telemetry", json, len);         // signed
   boat_device_publish_sealed("telemetry", json, len);  // signed and sealed
   ```
3. Read the device's key from its log. Apps follow the device by that key, and jobs name it.
4. Messages that others send to the device arrive at `on_message` with the sender's key, already checked by the node.

`examples/boat_device_min` is the smallest app built this way; its released image joined the public testnet from a board on its own (2026-11-11). `examples/mqtt_p2p` is a complete energy meter with a relay, tested on a board; the Quick Start's last step runs it.

### Prove your devices are genuine

A manufacturer can register a signing key with the network and sign a credential for each device on the production line. An owner then claims the device on chain with that credential and the device's own consent, signed by the device. A copy of your device cannot be claimed as yours. `examples/onboard.js` walks through it.

### Common questions

**Does a device need jobs to work?** No. A device can publish and receive without any. Jobs add paid verification, storage, billing or forwarding guarantees when someone needs them.

**Can a node change or fake my data?** No. A changed message fails the device's signature, and an old one fails its sequence number. A node can read data that is not sealed.

**What happens when the internet drops?** The device keeps retrying Wi-Fi indefinitely. In tests it was back on the network 6 seconds after Wi-Fi returned.

**What does it cost my customers?** Whoever posts jobs pays for them. Today, four jobs on a device that reports every 30 seconds cost about $42 a month, mostly chain fees; the next protocol change brings that to about $1.54. See [For apps and buyers](#for-apps-and-buyers).

## For node operators

Run a node, put up a stake, and earn for every unit of work that you and the other nodes assigned to it agree on. Sign something false and you lose part of your stake.

### What you earn

- **Pay per unit.** Each job sets a price per unit of work, five or twenty readings, say. When a unit settles, its pay is split among the nodes that signed it; a forwarding unit pays the node that carried the traffic.
- **Rewards that mature.** Earnings collect per epoch and become withdrawable after it. The node withdraws them on its own.
- **Delegation.** Others can delegate stake to you, which brings you more weight and more work. You set a commission on their share; a change to it takes effect only after a notice period.

In the Quick Start, one node had earned 3.17 test tokens after about a minute of work on three jobs.

### What it takes

| | |
| --- | --- |
| Machine | A small VM is enough for most loads. CPU grows with message rate: in our tests, a node's share of 100 devices took 85% of a vCPU at one reading a second, and would take about 3% at one reading every 30 seconds. |
| Software | Node.js 20 or later, and the `boat-node` program |
| Network | Internet access. No public IP or open port: nodes reach each other over HyperDHT, through NAT. |
| Stake | At least the network's minimum, in its stake token (1 USDC on Arc testnet today) |
| Gas | A little of the chain's native token, for registering and settling |

### Set up a node

1. Install it as a service. The script installs the [node software](#download), creates a system user and prints the operator address to fund.

   ```bash
   curl -fsSL https://iot.xid.network/dl/node/install.sh | sudo sh -s -- https://iot.xid.network/dl/node/boat-registry-0.1.0.tgz --rpc <rpc url> --registry <registry address> --roles forward,store,verify,compute
   ```

   From a checkout of xid-network (`git clone --recursive`), `sudo sh packages/boat-registry/deploy/install.sh . …` does the same with the source.
2. Send that address gas and your stake.
3. The service registers, stakes and starts taking jobs. Check it:

   ```bash
   sudo -u boat node /opt/boat-node/boat-registry/bin/boat-node.js status /var/lib/boat-node
   ```

   ```text
   "active": true,
   "stake": "100000000",
   "rewards": { "pending": "3166664", "matured": "0" }
   ```

Without systemd, run `boat-node init <dir>` and then `boat-node run <dir>`, as in the Quick Start. The node's seed and operator key stay in its directory with mode 600 and are never printed.

### Choose your roles

| Role | What your node does | What it needs most |
| --- | --- | --- |
| Forward | Carries devices' traffic | Bandwidth, uptime |
| Store | Keeps devices' signed history and serves it; can sell reads | Disk |
| Verify | Checks messages, watches other nodes, votes on slashes | CPU, uptime |
| Compute | Runs billing rules over readings | CPU |

A node can take all four. Verifiers also sign the node list that devices use to find nodes.

### Stay out of trouble

- **Wrong results are slashed.** Other nodes recompute your work. A wrong result costs part of your stake (20% per fault by default) and your pending rewards.
- **Signing two results for one unit is slashed** by anyone who holds both signatures.
- **A store that drops data is caught** by random spot checks with proofs.
- **Being offline is not slashed.** You are simply not paid for units you did not sign, and the work goes to the spare node.
- **Leaving takes time.** Start unbonding, then withdraw after the unbonding period. Your stake can still be slashed until then.

### Watch it run

Set `metricsPort` in the node's `node.json` and Prometheus can scrape `/metrics` on 127.0.0.1: active, stake, rewards, jobs, units signed and settled, faults, slashes and connected devices. The log also prints a status line every 5 minutes.

| `node.json` setting | Default | What it does |
| --- | --- | --- |
| `roles` | all four | Roles to register for |
| `stake` | the minimum | Stake to put up when registering |
| `maxJobs` | 20 | Most jobs the node takes |
| `network` | `boat-mqtt` | The name devices find nodes by |
| `reads`, `readPrice` | off | Sell reads of stored history |
| `metricsPort` | off | Prometheus metrics |
| `autoWithdraw` | on | Withdraw matured rewards |

## For apps and buyers

Use device data from anywhere, check it yourself, and pay only for results that independent nodes agreed on.

### Follow devices

You follow a device by its key, from any machine, with no account. Your app logs in with a key of its own, and every signed message is checked against the device's key before you see it.

```bash
npm install -g https://iot.xid.network/dl/node/boat-mqtt-node-0.1.0.tgz
boat-watch --network boat-mqtt --filter 'd/<device key>/#'
```

To send a device a command, add `--to <device key> --send <text>`. Devices decide who may command them; the energy meter, for example, obeys only its owner's key.

### Pay for checked work

Post a job on a device and staked nodes do the work. You are charged only for units that enough of them signed the same way.

| Job | What you get | Typical use |
| --- | --- | --- |
| Verify | Every message checked: signature, order, no replays | Proof that a data feed is complete and genuine |
| Store | The device's history kept by several nodes and served on request | Audit trails, back-filling your own database |
| Compute | A rule run over the readings, such as an energy bill, agreed by two of three nodes | Billing, payouts, alarms |
| Forward | Paid delivery of the device's traffic by its node | Service guarantees for connectivity |

You set the terms: pay per unit, how many nodes must agree, the budget, the most units it may settle per epoch, and a deadline.

```bash
boat-post-jobs --rpc <rpc url> --registry <registry address> --key-file payer.key --device <device key> --window 20 --pay 1000000 --units 200 --quorum 2
```

A device owner can also fund the device and let the device post its own jobs, signed by the device. When you no longer need a job, close it: after a notice period the unspent budget comes back to you.

### What it costs

Today each unit settles on chain. For a device reporting every 30 seconds with four jobs, that is about $0.0024 a unit and $42 a month, almost all of it chain fees. Settling one root per node per hour, the next protocol change, would bring the same work to about $1.54 a month. The [Economics](#economics) reference has the full model.

### Read a device's history

Stores keep each device's signed messages in an append-only log. Reading it checks every entry against the store's signed log and the device's own signature, so a store cannot hand you edited history.

```bash
boat-read-store <store key> <device key>
```

Stores can sell reads: you deposit with a store once, then sign small payment vouchers as you read, and the store cashes in the latest one.

### Private data

A device can seal its readings so that only readers it names can open them. To become a reader, give the device's owner your public key. Nodes still verify, store and bill sealed readings they cannot read: a billing node can be a reader too, if the owner allows it.

### Check it yourself

Every settled unit, every payment and every slash is on chain, and every result can be recomputed from the device's signed messages. `examples/snapshot.js` exports a network's nodes, jobs, settlements and slashes as data for your own dashboard.

## For DePIN networks {#depin}

Reward devices for what they sense or serve, and where, without running the oracles yourself. `xid-depin` turns a template into a network:
- a contract that holds your reward curve and pays your devices;
- a job on the registry that pays xid nodes to score each epoch.

The testnet runs one: [the weather demo](/depin/).

### What you get

| Piece | What it does |
| --- | --- |
| Templates | Weather, air quality and energy networks: what a reading is, what is rewarded, the curve. Change what you need |
| Reward curves | Constant, halving, exponential, linear or steps, with a floor and an end. The contract caps every epoch at the curve |
| Proof of location | A device names its H3 cell in a record it signs. Oracles time a signed ping and rule out any cell further than light in fibre allows: 100 km per ms of round trip |
| Proof of coverage | Devices beacon over the radio (ESP-NOW, BLE) and report what they hear. A witness counts when it is in range, the signal fits the distance, and it is paid to someone else |
| Crowding | Devices that crowd one area share what a few would earn |
| Oracles | The registry's compute nodes, assigned like any job, paid per epoch from your job's budget. Enrollment fees top it up |

### Start a network

```bash
npm install -g https://iot.xid.network/dl/node/xid-depin-0.1.0.tgz
xid-depin templates
xid-depin new weather ./wx --name my-weather --epoch 86400
# edit ./wx/config.json: fields, weights, curve, token
xid-depin deploy ./wx --testnet --key admin.key --budget 100 --mint
xid-depin keeper ./wx --home <a node key> --key admin.key --claim
```

- **`deploy`** puts three things on chain:
    - the reward token, which the network mints as epochs are published;
    - the network contract;
    - the oracles' job.

    The config's hash is fixed in the contract, and the job carries the config itself.
- **`keeper`**:
    - keeps the network's key pointing at a node, where its oracles meet;
    - sends enrollment fees to the job;
    - claims each epoch's rewards for the payees.

### How an epoch is scored

1. **Devices sign** readings with a time, a join record (where they are and who is paid), beacons and the beacons they hear.
2. **Oracles collect.** The job's assigned nodes follow every enrolled device and time a signed ping to it each minute.
3. **Oracles publish their sheets.** After the epoch, each oracle publishes what it holds on each device, and an index of it signed with its stake key.
4. **Oracles score.**
    - Each oracle scores from all the oracles' sheets. A message counts only when most of them hold it, so one oracle can neither add readings nor drop them.
    - Each oracle signs the root of the rewards tree once.
5. **The registry settles.** A quorum of the same root settles on the registry, and the oracles are paid.
6. **Anyone publishes.** The contract checks the settled statement and the curve's cap.
7. **Anyone claims** a device's reward with a Merkle proof. It goes to the device's payee.

`xid-depin audit <dir> <epoch>` scores an epoch again from the published sheets and compares the root with the one on chain. An oracle that signs two roots for one epoch loses half its stake.

### Devices

A device in your network publishes these, signed with its own key:

| Topic | What |
| --- | --- |
| `d/<device>/<readings topic>` | The config's fields as integers, and `ts` (unix seconds) |
| `d/<device>/depin/<network key>/join` | Retained: `{ v: 1, net, cell, payee }`, where it is (an H3 cell) and who is paid |
| `d/<device>/depin/<network key>/witness` | The beacons it heard in a slot, with their signal strength |
| `d/<device>/depin/<network key>/pong` | `{ v: 1, nonce }`, its answer to an oracle's ping |

An ESP32-C3 runs `examples/depin_station`, built on the `boat_depin` component. It answers pings, publishes its join record and readings, beacons over ESP-NOW once a slot and reports the beacons it hears. Flash it, then enroll it and set it up from a computer:

```bash
xid-depin get ./wx --testnet         # the testnet's weather demo
xid-depin station ./wx --testnet --device <the key it prints> --lat 1.290 --lon 103.852 --payee 0x...
# then type the `depin set ...` line it prints on the station's console
```

The line ends with the node the station should be on: the network's oracle nearest to it. Every oracle's ping reaches a device through the device's node, so on a far node the round trips say nothing about where it is; on the nearest oracle's node, that oracle's round trip is the station's own. The station dials that node first when the node list has it.

`xid-depin sim` runs simulated devices of a network at the places you give, with a simulated radio between them. `lib/device.js` is the same in Node for gateways.

```bash
xid-depin sim ./wx --home <node key> --stations "roof@25.03,121.56;garden@25.031,121.563"
```

### Run an oracle

Any node with the compute role becomes an oracle when the plan assigns it a network's job. Install it with the plugin, and say where the node is:

```bash
curl -fsSL https://iot.xid.network/dl/node/install.sh | sudo sh -s -- \
  https://iot.xid.network/dl/node/boat-registry-0.1.0.tgz --testnet --depin 25.03,121.56
```

### Limits

- **Location.** A round trip can rule a place out, never prove one. Within a few ms of an oracle, it is the radio witnesses that place devices relative to each other.
- **Fake devices.** What stops one person from posing as many devices is keys kept in hardware, with a manufacturer's credential.
- **Round trips through the device's node.** An oracle's ping reaches a device through the node the device is on, so a device on a far node is far from every oracle. `xid-depin station` puts a station on the oracle nearest to it. Only that oracle's round trip is the device's own; the others' include their leg to that node. Oracles do not yet take that leg off.
- **Round trips from Wi-Fi boards.** An ESP32-C3 with Wi-Fi A-MPDU receive on held arriving frames for about 150 ms. Its pongs took 240 ms over a 55 ms network. `depin_station` turns it off: 77–90 ms. A round trip of 80 ms still allows 8,000 km; only stations close to an oracle are placed tightly.
- **Radio witnesses on hardware.** The ESP32 station's beacons verify in JS, and it checks and reports what it hears. Two stations hearing each other over ESP-NOW has not been tested yet.

## Reference

How the network works underneath, for anyone who wants to check our reasoning or build on the protocol itself.

### Concepts

Eight ideas explain the whole network. Each one maps to a part of the code you can read.

**Device.** A device owns an Ed25519 key pair; its public key is its address. It publishes under its own topic namespace, `d/<device key>/…`, and signs every message: `'S' 0x01 | seq (8 bytes) | signature (64 bytes) | payload`. The sequence number is `boot << 32 | count`, so a node can refuse a replay without trusting anyone. Signing takes about 21 ms on an ESP32-C3.

**Home node.** A device connects to one forwarding node over HyperDHT (hole-punched, no public IP needed) and names it in its own signed DHT record. Anyone who wants the device's data looks up that record and subscribes at that node. A device that moves updates the record; followers move with it.

**Roles.** A node registers for one or more roles and stakes the network's token for them.

| Role | Bit | What the node does | What it signs per unit |
| --- | --- | --- | --- |
| Forward | 1 | Carries the device's MQTT traffic over HyperDHT | The Merkle root of what it forwarded, with its own address |
| Store | 2 | Keeps the device's signed history in an append-only Hypercore and serves it | The root of what it stored |
| Verify | 4 | Checks every message's signature, sequence and replay status; watches other nodes' work | The root of its verdicts |
| Compute | 8 | Runs the job's WASM rule over the readings (an energy bill, say) | The hash of the inputs and the value |

**Job.** Anyone can pay for work on a device's data: `postJob(device, terms, params)`. The terms set the role, the quorum, the pay per unit, the budget, a rate limit per epoch and a deadline. The params set the window and, for compute, the topic, the field and the rule. A device can fund its own jobs and sign the request itself (`postJobFromDevice`).

**Unit.** A unit is a window of consecutive sequence numbers from one device boot, five or twenty readings, say. Every assigned node computes the unit's result on its own and signs a work statement over (registry, chain, job, unit, result).

**Assignment.** Each job is worked by quorum + 1 nodes of its role, picked by a hash of operator and device, so a device's jobs land on the same few nodes. Three verifiers, picked the same way, watch each device.

**Quorum and settlement.** When `quorum` assigned nodes have signed the same result, one of them submits the signatures and the contract pays each signer from the job's budget. Submitters take turns by rank, and many units go in one transaction (`settleMany`).

**Watchers and slashing.** Watchers recompute other nodes' results and spot-check one store unit in ten. A wrong result becomes a fault that a stake-weighted quorum of verifiers signs; the contract then takes 20% of the offender's stake, pays the reporter from that loss and forfeits the offender's pending rewards. A node that signs two results for one unit can be slashed by anyone (`slashDoubleWork`).

Two more pieces complete the picture. Verifiers publish a signed **node list** in the DHT; a device trusts it when 2 of the 3 verifiers it knows agree, so it never needs to read a chain. **Sealed readings** are encrypted with XChaCha20-Poly1305; the device puts the data key in an envelope for each reader it names, and nodes that are not readers can still verify and store what they cannot read.

### How a unit settles

![A reading becomes paid work only when a quorum agrees](img:sequence)

Steps 1 to 6 happen for every unit, in seconds; step 7 happens only when a node signs something the watchers' own result contradicts. The node that submits takes turns by rank, and a backup submits if it does not, so no single node can hold a unit back.

### Contracts

Two contracts hold everything that must be agreed on: who is staked, which jobs are open, which units settled, who was slashed. Everything else (messages, data, verdicts) stays off chain. Both take any ERC-20 as stake and pay; the Arc testnet deployment uses USDC.

**BoatRegistry** (`contracts/BoatRegistry.sol`, built with via-IR, 20.9 KB)

| Area | Functions | Who calls them |
| --- | --- | --- |
| Nodes | `register(dhtKey, roles, amount)`, `addStake`, `startUnbonding`, `withdraw`, `isActive(operator, role)` | Node operators |
| Jobs | `postJob(device, terms, params)`, `fundJob`, `closeJob` (after a notice period), `jobCount` | Anyone who pays for work |
| Device-funded jobs | `fundDevice(did, amount)`, `withdrawDevice`, `postJobFromDevice(did, terms, params, sig)` | Device owners; the device signs the request |
| Settlement | `settle`, `settleForward`, `settleMany`, `settleForwardMany` (one failing item does not revert the batch) | The node whose turn it is |
| Slashing | `slash(operator, amount, reason, nonce, sigs)` by a stake-weighted verifier quorum; `slashDoubleWork` and `slashEquivocation` by anyone with the two signatures | Verifiers, anyone |
| Rewards | `epoch`, `rewards(operator)` (pending and matured), `withdrawRewards` | Node operators |
| Delegation | `delegate`, `undelegate(operator, shares)`, `withdrawUndelegated`, `setCommission(bps)` with a notice period | Token holders, operators |
| Device identity | `setIssuer`, `claimDevice(did, wallet, credential, consent)` | Manufacturers, owners |
| Governance | `govern(kind, target, value, nonce, sigs)` by verifiers; `renounceAdmin` | Verifiers; the admin, once |

Rules the contract enforces on its own:

- A new verifier counts toward a slash quorum only from the epoch after it joined, and only with its stake's weight.
- A slash's reporter is paid only from the offender's loss, never from the treasury.
- Stake that is leaving (unbonding or undelegated) can still be slashed until it is gone.
- A job settles at most `perEpoch` units an epoch, so a few colluding nodes cannot drain its budget at once.
- Each unit settles once; its result is kept as `settled(keccak(job, unit))`.

**BoatReads** (`contracts/BoatReads.sol`) sells reads of stored history. A reader opens a channel to a store with a deposit (`open`), then signs vouchers off chain for the cumulative amount as it reads. The store redeems the latest voucher (`redeem`). Closing a channel (`close`) waits out a notice period, and a reopened channel starts a new generation, so old vouchers are worthless.

### Performance

With room on the machine, 12 nodes settled 99.7% of 23,600 units in 5 minutes, half of them within 7 seconds. The tests run real `boat-node` processes, a local chain and meters that each send a signed reading every second, with four jobs (verify, store, compute, forward) on every meter.

| Test | Nodes, meters | Units settled | Settled a second | Latency p50 / p99 |
| --- | --- | --- | --- | --- |
| One Mac (M4, 10 cores) | 24, 100, two kinds of job | 100% | 34 | 1.9 s / 4.3 s |
| One Mac | 24, 200, two kinds of job | 99% | 67 | 9 s (p50) |
| GCP, 4 nodes per 4-vCPU machine | 12, 100, four kinds | 99.7% | 75 | 7.0 s / 23 s |
| GCP, 8 nodes per 4-vCPU machine | 24, 200, four kinds | 37.9% | 57 | 95 s / 216 s |

The last row is what happens when nodes run out of CPU: 8 nodes on 4 vCPUs fall behind and never catch up. A node's CPU follows its message rate. At one reading a second, a node working about 100 jobs and watching as many needs most of a vCPU; at one reading every 30 seconds, about 3%.

What made it scale, each found by a run that stalled:

- Each job goes to quorum + 1 nodes and three watchers per device, not to every node.
- Work is published only at the device's home node, with one subscription per node.
- Units settle in batches of up to 40 (`settleMany`); a node sends its next batch without waiting for the last receipt.
- Signatures are checked only by the node that submits, or when work looks wrong; checking every one took a fifth of a busy node's time.
- One store unit in ten is spot-checked, not every one.

A settled unit costs about 94,000 gas in a batch, against 120,800 alone.

### Economics

Settling every unit on chain costs a device about $42 a month, 98.5% of it gas; one Merkle root per node per hour would bring that to about $1.54. The figures come from `bench/economics.js`: gas measured on Arc testnet at 25 gwei, a reading every 30 seconds, four jobs per device, three signers per unit, and nodes on $13-a-month VMs with $100 of stake earning 5% elsewhere, plus a 20% margin.

| How units settle | Units per job a day | Pay per unit | Gas share of pay | A device a month |
| --- | --- | --- | --- | --- |
| Every unit, one transaction each | 144 | $0.0031 | 98.8% | $52.83 |
| Every unit, in batches (today) | 144 | $0.0024 | 98.5% | $41.68 |
| Units of an hour, in batches | 24 | $0.0026 | 91.4% | $7.48 |
| Units of a day, in batches | 1 | $0.0077 | 30.7% | $0.93 |
| Every unit, one root per node per hour | 144 | $0.000089 | 58.3% | $1.54 |

A small node costs $0.45 a day and holds about 300 device-jobs, so 1,000 devices need about 40 nodes. Longer units cut gas but settle later and put more pay at risk per unit. Epoch roots keep units short and settle each node's work in one transaction an hour; they are the next protocol change.

### Security model

No single node is trusted with anything: a device's data is checked against the device's own key, and a node is paid only when a quorum of independent nodes signed the same result. What remains trusted is the chain, the device's key, and verifiers holding more than two thirds of the verifier stake.

| Threat | What stops it |
| --- | --- |
| A node forges or alters a reading | Every message carries the device's Ed25519 signature over topic, sequence and payload |
| A node replays old readings | Sequence numbers only rise, across reboots; a lower one is refused |
| A node drops readings it should store | Watchers spot-check stores with Merkle proofs of random blocks; missing readings are fetched from other stores |
| A node signs a wrong result to get paid | Other assigned nodes disagree, so no quorum forms; watchers raise a fault and the node is slashed |
| A node signs two results for one unit | Anyone can submit both signatures to `slashDoubleWork` |
| A device is pointed at fake nodes | It trusts a node list only when 2 of its 3 verifiers signed the same one |
| Nodes collude to drain a job | Assignment is fixed by hash, not chosen; a job pays at most `perEpoch` units an epoch |
| An operator runs away before a slash | Stake that is unbonding or undelegated stays slashable until it leaves |
| A sybil flood of verifiers | Verifier votes are weighted by stake and count only from the epoch after joining |
| Someone reads private data | Sealed readings are encrypted; only readers the device named get the key |

An independent review of the contracts found three high, three medium and three low findings. Among the high ones were a reporter able to profit from reporting itself, delegators leaving to escape a slash, and cheap verifiers outvoting real ones. All are fixed and covered by tests, and Foundry invariant tests (500 runs of 150 calls) hold. There has been no third-party audit yet, and the contracts run on testnets only.

What the design does not stop: a quorum of the nodes assigned to a job, together with its watchers, can agree on a wrong result. Raising the quorum and the number of watchers makes that more expensive.

### Status

xid network runs on testnets with real hardware; it is not on a mainnet yet. Everything below is in the repository; the contracts and the node pass 14 test suites.

| Part | State |
| --- | --- |
| [Public testnet](#testnet) | Since 2026-11-11: registry v4 on Arc testnet (`0x26Ae7fCe8FBB4cAcE6778eC00a4EfFe785D83329`) with TSUSD as stake, four nodes in the US, EU, Taiwan and Japan, a faucet and a [live page](https://iot.xid.network/network/). An ESP32-C3 flashed with the released `boat_device_min` joined it on its own, after taking its Wi-Fi over Improv |
| Earlier deployments | Registry v3 on Arc testnet with USDC as stake (`0xCf0977882e057297891402C7a985E35569d63d5f`); registry v2, where a lying node was slashed on chain during a 24-hour soak with an ESP32-C3 as the meter |
| boat-node | Runs as a process or a systemd service; Prometheus metrics; `--testnet` joins the public testnet |
| ESP32-C3 firmware | `depin_station` ran on a board on the testnet's weather network on 2026-11-12: it was enrolled through the site, located, scored and paid, and was up in every slot of a full epoch with no restart. Put on the oracle nearest to it, with Wi-Fi A-MPDU receive off, its round trips fell from 377–429 ms (on a far node) to 78 ms for the nearest oracle (epoch 17). `mqtt_p2p` and `boat_mer` tested on a board over the public HyperDHT. Released images of `boat_device_min` and `uart_module` ([Download](#download)) |
| Scale | 24 hours with 16 nodes on 4 machines and 1,000 simulated devices: 2.3 million units, 95.4% settled, units settled in Merkle batches (12.8 batches a transaction) |

Not done yet:

- A third-party audit.
- Tests on 4G and with a real energy meter.
- Memory that still grows about 45 MB an hour on a busy node, and settlement latency that grows with it.
- A published Docker image (the Dockerfile is in `packages/boat-registry/deploy`).
