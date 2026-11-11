# boat_wifi

A Wi-Fi station for ESP32 firmware that ships as one image for everyone: the
network is not compiled in but set over the serial console with
[Improv Wi-Fi](https://www.improv-wifi.com/serial/), as browser installers
such as [ESP Web Tools](https://esphome.github.io/esp-web-tools/) do right
after flashing, and kept in NVS.

```c
boat_wifi_config_t cfg = {
  .nvs_namespace = "my_wifi",
  .firmware = "my-app",           // Improv device info
  .on_line = my_commands,         // other lines typed on the console (optional)
};
ESP_ERROR_CHECK(boat_wifi_start(&cfg));
boat_wifi_wait(portMAX_DELAY);    // until it has an address
```

- **Improv**: device info, the current state, a scan of the networks around,
  and the network to join. A new network is kept only if it gets an address
  within 20 s; otherwise the device goes back to the one before and reports
  "unable to connect".
- **Console**: Improv runs on whichever port is the console (USB Serial/JTAG
  or a UART). Packets go straight through the port's driver, as lines of
  their own between the logs; other text lines go to `on_line`, for the
  app's own settings.
- **Default network**: `cfg.ssid` is used while none was set, for a
  developer's build (the examples take it from `sdkconfig.wifi`). Release
  builds leave it empty.
- **Reconnects**: every second, however long the network is gone.

`boat_wifi_set(ssid, password)` sets the network from code, and
`boat_wifi_set("", "")` forgets it.

Used by [`examples/boat_device_min`](../../examples/boat_device_min).
