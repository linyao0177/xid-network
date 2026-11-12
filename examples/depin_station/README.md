# depin_station

A station of a DePIN network on the xid network:
[`boat_device`](../../components/boat_device) for its identity and nodes, and
[`boat_depin`](../../components/boat_depin) for the network (join record,
pongs, readings, ESP-NOW beacons and witness reports). It joins the public
testnet's nodes (`tools/release/sdkconfig.testnet`).

## Make it a station

1. Flash it. Wi-Fi comes from the repo root's `sdkconfig.wifi` in a
   developer's build, or over Improv in a release build.

   ```sh
   idf.py build flash monitor
   ```

   It prints its key: `DEPIN|device <key>`.

2. On a computer, get the network, enroll the station and get its settings
   ([`packages/xid-depin`](../../packages/xid-depin)). On the testnet, the
   site enrolls it for free; with `--key`, you pay the fee.

   ```sh
   xid-depin get weather --testnet
   xid-depin station weather --testnet --device <key> --lat 1.290 --lon 103.852 --payee 0x...
   ```

3. Type the line it prints on the station's console. The station restarts
   and starts working for the network.

   ```
   depin set <network key> <cell> <payee> <start> <slot seconds> <topic> [rated W]
   ```

## Console

| Command | What |
| --- | --- |
| `depin set …` | The station's settings (from `xid-depin station`); it restarts |
| `depin show` | Its key, settings, slot, and what it did so far |
| `depin beacon` | The beacon it sends in this slot, signed, as JSON |
| `depin off` | A plain device again |

Every `CONFIG_DEPIN_INTERVAL` seconds (60) it publishes a reading and
prints `DEPIN|reading …` with its counts of joins, pongs and beacons.

## Readings

`read_fields()` in `main/main.c` gives the network's fields. With
`CONFIG_DEPIN_WEATHER_DEMO` (the default), a bare board joins the testnet's
weather network: `t` is the chip's own temperature sensor, a few degrees
above the air around it, and `h` and `p` are made up. A real station reads
its sensors there instead, in the network's units.
