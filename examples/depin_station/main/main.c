// A station of a DePIN network on the xid network: components/boat_device for
// the device's identity and nodes, components/boat_depin for the network
// (join record, pongs, readings, ESP-NOW beacons and witness reports).
//
// It starts as a plain device on the public testnet and prints its key. To
// make it a station, enroll it and get its settings with xid-depin on a
// computer:
//
//   xid-depin get weather --testnet
//   xid-depin station weather --device <its key> --lat <lat> --lon <lon> --payee 0x...
//
// which prints one line to type on its console:
//
//   depin set <network key> <cell> <payee> <start> <slot seconds> <topic> [rated W] [node]
//   depin show       the settings, the slot and what it did so far
//   depin beacon     the beacon it sends in this slot (signed), as JSON
//   depin off        a plain device again
//
// node: the oracle node nearest to it (xid-depin station picks it), which it
// dials first, so the oracles' pings take a short way to it. The device
// restarts to use new settings.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "driver/temperature_sensor.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "boat_depin.h"
#include "boat_device.h"
#include "boat_wifi.h"

#define DEVICE_NS "depin_dev" // boat_device's: seed, boot counter, trusted verifiers
#define CONFIG_NS "depin_cfg" // the station's settings: one line

static char line_set[400]; // what `depin set` saved, without "depin set "
static boat_depin_config_t station;
static bool configured;
static char net[65], cell[24], payee[43], topic[48], node[65];

static bool
is_hex (const char *s, size_t len) {
  if (strlen(s) != len) return false;
  for (; *s; s++)
    if (!((*s >= '0' && *s <= '9') || (*s >= 'a' && *s <= 'f'))) return false;
  return true;
}

// "<net> <cell> <payee> <start> <slot> <topic> [rated] [node]" into station
static bool
parse (const char *s) {
  char start[24], slot[16], rated[16] = "0", x[2][68] = { "", "" };
  int n = sscanf(s, "%64s %23s %42s %23s %15s %47s %67s %67s", net, cell, payee, start, slot, topic, x[0], x[1]);
  if (n < 6) return false;
  node[0] = 0;
  for (int i = 0; i < 2; i++) { // the extras: a number (rated W) or a key (node)
    if (!x[i][0]) continue;
    size_t len = strlen(x[i]);
    if (is_hex(x[i], 64)) memcpy(node, x[i], 65);
    else if (strspn(x[i], "0123456789") == len && len < sizeof(rated)) memcpy(rated, x[i], len + 1);
    else return false;
  }
  station = (boat_depin_config_t) {
    .net = net,
    .cell = cell,
    .payee = payee,
    .topic = topic,
    .start = strtoll(start, NULL, 10),
    .slot_seconds = (uint32_t) strtoul(slot, NULL, 10),
    .rated = (uint32_t) strtoul(rated, NULL, 10),
    .beacons = true,
  };
  return strlen(net) == 64 && strlen(cell) >= 15 && strlen(payee) == 42 && station.start > 0 && station.slot_seconds > 0;
}

static void
load (void) {
  nvs_handle_t nvs;
  size_t len = sizeof(line_set);
  if (nvs_open(CONFIG_NS, NVS_READONLY, &nvs) != ESP_OK) return;
  if (nvs_get_str(nvs, "depin", line_set, &len) == ESP_OK) configured = parse(line_set);
  nvs_close(nvs);
}

static void
show (void) {
  boat_depin_stats_t st;
  boat_depin_get_stats(&st);
  printf("DEPIN|device %s\n", boat_device_key() ? boat_device_key() : "(not started)");
  if (!configured) {
    printf("DEPIN|not a station yet: depin set <network key> <cell> <payee> <start> <slot seconds> <topic> [rated W] [node]\n");
    return;
  }
  printf("DEPIN|network %s cell %s payee %s topic %s slot %lld of %lu s\n", net, cell, payee, topic, (long long) boat_depin_slot(), (unsigned long) station.slot_seconds);
  printf("DEPIN|node %s\n", node[0] ? node : "(any listed)");
  printf("DEPIN|stats joins=%lu pongs=%lu readings=%lu beacons_sent=%lu beacons_heard=%lu beacons_bad=%lu witness=%lu\n", (unsigned long) st.joins, (unsigned long) st.pongs, (unsigned long) st.readings,
         (unsigned long) st.beacons_sent, (unsigned long) st.beacons_heard, (unsigned long) st.beacons_bad, (unsigned long) st.witness_reports);
}

static void
save (const char *value) {
  nvs_handle_t nvs;
  if (nvs_open(CONFIG_NS, NVS_READWRITE, &nvs) != ESP_OK) return;
  if (value) nvs_set_str(nvs, "depin", value);
  else nvs_erase_key(nvs, "depin");
  nvs_commit(nvs);
  nvs_close(nvs);
  printf("DEPIN|saved; restarting\n");
  vTaskDelay(pdMS_TO_TICKS(300));
  esp_restart();
}

// a line typed on the console
static void
on_line (const char *line, void *ctx) {
  (void) ctx;
  while (*line == ' ') line++;
  if (strcmp(line, "depin show") == 0) show();
  else if (strcmp(line, "depin off") == 0) save(NULL);
  else if (strcmp(line, "depin beacon") == 0) {
    char b[260];
    esp_err_t err = boat_depin_beacon_json(b, sizeof(b));
    if (err == ESP_OK) printf("DEPIN|beacon %s\n", b);
    else printf("DEPIN|error: no beacon now (%s)\n", esp_err_to_name(err));
  }
  else if (strncmp(line, "depin set ", 10) == 0) {
    const char *v = line + 10;
    boat_depin_config_t keep = station;
    if (strlen(v) >= sizeof(line_set) || !parse(v)) {
      station = keep;
      printf("DEPIN|error: depin set <network key> <cell> <payee> <start> <slot seconds> <topic> [rated W] [node]\n");
      return;
    }
    save(v);
  } else if (strncmp(line, "depin", 5) == 0) printf("DEPIN|error: depin set ..., depin show, depin off\n");
}

// what others send to the device: d/<sender>/to/<device>/<what>
static void
on_message (const char *from, const char *what, const uint8_t *data, size_t len, void *ctx) {
  (void) ctx;
  (void) data;
  (void) len;
  if (boat_depin_message(from, what, data, len)) return;
  printf("DEPIN|message from %.12s... (%s)\n", from, what);
}

static void
on_connected (const char *on, void *ctx) {
  (void) ctx;
  printf("DEPIN|on node %.16s...%s\n", on, !node[0] ? "" : strcmp(on, node) == 0 ? " (the one near it)" : " (not the one near it: it was not listed or did not answer)");
  boat_depin_connected();
}

// the network's fields, as JSON members (integers)
static temperature_sensor_handle_t tsens;

static int
read_fields (char *out, size_t size) {
#ifdef CONFIG_DEPIN_WEATHER_DEMO
  // t: the chip's own temperature (a few degrees above the air around it);
  // h and p: made up, for a bare board on the testnet's weather network
  float c = 0;
  if (!tsens) {
    temperature_sensor_config_t tc = TEMPERATURE_SENSOR_CONFIG_DEFAULT(-10, 80);
    if (temperature_sensor_install(&tc, &tsens) == ESP_OK) temperature_sensor_enable(tsens);
  }
  if (tsens) temperature_sensor_get_celsius(tsens, &c);
  return snprintf(out, size, "\"t\":%d,\"h\":%u,\"p\":%u", (int) (c * 10), 550 + (unsigned) (esp_random() % 100), 10100 + (unsigned) (esp_random() % 40));
#else
  // a real station: its sensors, in the network's units
  (void) size;
  out[0] = 0;
  return 0;
#endif
}

void
app_main (void) {
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    err = nvs_flash_init();
  }
  ESP_ERROR_CHECK(err);
  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  load();

  boat_wifi_config_t wifi = {
    .nvs_namespace = "boat_wifi",
    .firmware = "depin_station",
    .device_name = "DePIN station",
#ifdef CONFIG_EXAMPLE_WIFI_SSID
    .ssid = CONFIG_EXAMPLE_WIFI_SSID,
    .password = CONFIG_EXAMPLE_WIFI_PASSWORD,
#endif
    .on_line = on_line,
  };
  ESP_ERROR_CHECK(boat_wifi_start(&wifi));
  boat_wifi_wait(portMAX_DELAY);
  // awake, to hear the neighbours' beacons
  esp_wifi_set_ps(WIFI_PS_NONE);

  // the clock: readings carry ts, and slots are counted from the network's start
  esp_sntp_config_t sntp = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
  esp_netif_sntp_init(&sntp);
  if (esp_netif_sntp_sync_wait(pdMS_TO_TICKS(20000)) != ESP_OK) printf("DEPIN|clock not set yet (SNTP); it keeps trying\n");

  boat_device_config_t cfg = {
    .nvs_namespace = DEVICE_NS,
    .network = CONFIG_BOAT_NETWORK[0] ? CONFIG_BOAT_NETWORK : NULL,
    .verifiers = CONFIG_BOAT_VERIFIERS[0] ? CONFIG_BOAT_VERIFIERS : NULL,
    .node = configured && node[0] ? node : NULL, // near it: short round trips to the oracles
    .on_message = on_message,
    .on_connected = on_connected,
  };
  ESP_ERROR_CHECK(boat_device_start(&cfg));
  if (configured && (err = boat_depin_start(&station)) != ESP_OK) {
    printf("DEPIN|station settings refused: %s\n", esp_err_to_name(err));
    configured = false;
  }
  show();

  for (unsigned n = 0;; n++) {
    vTaskDelay(pdMS_TO_TICKS(CONFIG_DEPIN_INTERVAL * 1000));
    if (!configured) {
      if (n % 10 == 0) show();
      continue;
    }
    char fields[160];
    read_fields(fields, sizeof(fields));
    err = boat_depin_reading(fields);
    boat_depin_stats_t st;
    boat_depin_get_stats(&st);
    printf("DEPIN|reading %u slot %lld {%s}: %s; joins %lu pongs %lu beacons %lu sent %lu heard witness %lu\n", n, (long long) boat_depin_slot(), fields, esp_err_to_name(err), (unsigned long) st.joins, (unsigned long) st.pongs,
           (unsigned long) st.beacons_sent, (unsigned long) st.beacons_heard, (unsigned long) st.witness_reports);
  }
}
