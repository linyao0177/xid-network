// boat_wifi: a Wi-Fi station whose network is set over the serial console.
//
//   boat_wifi_config_t cfg = { .nvs_namespace = "my_wifi", .firmware = "my-app" };
//   boat_wifi_start(&cfg);
//   boat_wifi_wait(portMAX_DELAY);   // until it has an address
//
// The network is kept in NVS. Until one is set, the station waits; the
// default network (cfg.ssid, from sdkconfig in a developer's build) is used
// only while none was set.
//
// It speaks Improv Wi-Fi over the serial console (USB Serial/JTAG or UART,
// whichever is the console): a browser installer such as ESP Web Tools asks
// for the network right after flashing and sends it, and it can list the
// networks around. Improv packets are lines of their own among the logs.
//
// Text lines typed on the console go to cfg.on_line, for the app's own
// settings.
//
// The network can also be set from code (boat_wifi_set) and is forgotten
// with boat_wifi_set("", "").

#ifndef BOAT_WIFI_H
#define BOAT_WIFI_H

#include <stdbool.h>

#include "esp_err.h"
#include "freertos/FreeRTOS.h"

typedef struct {
  const char *nvs_namespace; // where the network is kept (default "boat_wifi")
  const char *firmware;      // Improv device info: firmware name
  const char *version;       // and version (default: the app's version)
  const char *device_name;   // and the name shown to the user (default: firmware)
  const char *ssid;          // the default network, while none was set (may be NULL)
  const char *password;
  bool no_improv;            // true: no Improv on the console (it has other uses)
  // other lines typed on the console (not Improv packets), for the app's own
  // commands; called on the console's reader task
  void (*on_line)(const char *line, void *ctx);
  void *ctx;
} boat_wifi_config_t;

// starts the station (and Improv on the console unless no_improv); needs
// nvs_flash_init, esp_netif_init and the default event loop first
esp_err_t
boat_wifi_start (const boat_wifi_config_t *cfg);

// true once it has an address, within timeout
bool
boat_wifi_wait (TickType_t timeout);

bool
boat_wifi_connected (void);

// sets and keeps the network ("" forgets it) and connects to it
esp_err_t
boat_wifi_set (const char *ssid, const char *password);

#endif
