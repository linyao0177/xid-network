// The smallest BoAT device: a reading every few seconds, signed (and sealed
// to its readers when it has some), on the BoAT network of staked nodes.
// Everything else is components/boat_device.
//
// Wi-Fi comes over Improv (components/boat_wifi): the browser installer asks
// for the network right after flashing. The rest can be set on the console,
// so one released image serves any network:
//
//   boat network <name>          the network name to look up (default CONFIG_BOAT_NETWORK:
//                                xid-testnet in release builds, else boat-mqtt)
//   boat verifiers <hex,hex,..>  verify keys whose node list it trusts
//   boat readers <hex,hex,..>    keys that may read its readings (sealed)
//   boat show                    what it uses now
//
// A setting with no value goes back to the firmware's default. The device
// restarts to use a new setting.

#include <ctype.h>
#include <stdio.h>
#include <string.h>

#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "boat_device.h"
#include "boat_wifi.h"

#define DEVICE_NS "boat_min" // boat_device's: seed, boot counter, trusted verifiers
#define CONFIG_NS "boat_cfg" // the settings below

static char network[64];
static char verifiers[16 * 65];
static char readers[16 * 65];

// a setting from NVS, else the firmware's default
static void
setting (const char *key, char *out, size_t size, const char *fallback) {
  nvs_handle_t nvs;
  size_t len = size;
  if (nvs_open(CONFIG_NS, NVS_READONLY, &nvs) == ESP_OK) {
    esp_err_t err = nvs_get_str(nvs, key, out, &len);
    nvs_close(nvs);
    if (err == ESP_OK) return;
  }
  snprintf(out, size, "%s", fallback);
}

// comma-separated 64-character hex keys (or empty)
static bool
keys_ok (const char *s) {
  size_t n = 0;
  for (const char *p = s; *p;) {
    for (int i = 0; i < 64; i++, p++) if (!isxdigit((unsigned char) *p)) return false;
    if (++n > 15) return false;
    if (*p == ',') p++;
    else if (*p) return false;
  }
  return true;
}

static size_t
keys_count (const char *s) {
  return s[0] ? (strlen(s) + 1) / 65 : 0;
}

static void
show (void) {
  printf("BOAT|config network=%s verifiers=%u readers=%u device=%s\n", network[0] ? network : "boat-mqtt", (unsigned) keys_count(verifiers), (unsigned) keys_count(readers), boat_device_key() ? boat_device_key() : "(not started)");
}

// a line typed on the console
static void
on_line (const char *line, void *ctx) {
  (void) ctx;
  while (*line == ' ') line++;
  if (strncmp(line, "boat ", 5) != 0) return;
  line += 5;
  if (strcmp(line, "show") == 0) {
    show();
    return;
  }
  char key[16] = "";
  const char *value = strchr(line, ' ');
  size_t klen = value ? (size_t) (value - line) : strlen(line);
  if (klen >= sizeof(key)) klen = sizeof(key) - 1;
  memcpy(key, line, klen);
  value = value ? value + 1 : "";
  while (*value == ' ') value++;
  bool known = strcmp(key, "network") == 0 || strcmp(key, "verifiers") == 0 || strcmp(key, "readers") == 0;
  if (!known) {
    printf("BOAT|error: boat network|verifiers|readers <value>, or boat show\n");
    return;
  }
  if (strcmp(key, "network") == 0 ? strlen(value) >= sizeof(network) : !keys_ok(value)) {
    printf("BOAT|error: %s: %s\n", key, strcmp(key, "network") == 0 ? "too long" : "comma-separated 64-character hex keys, at most 15");
    return;
  }
  nvs_handle_t nvs;
  if (nvs_open(CONFIG_NS, NVS_READWRITE, &nvs) != ESP_OK) return;
  if (value[0]) nvs_set_str(nvs, key, value);
  else nvs_erase_key(nvs, key);
  nvs_commit(nvs);
  nvs_close(nvs);
  // the node list keeps the verifiers it learned; new ones start over
  if (strcmp(key, "verifiers") == 0 && nvs_open(DEVICE_NS, NVS_READWRITE, &nvs) == ESP_OK) {
    nvs_erase_key(nvs, "verifiers");
    nvs_commit(nvs);
    nvs_close(nvs);
  }
  printf("BOAT|saved %s; restarting\n", key);
  vTaskDelay(pdMS_TO_TICKS(300));
  esp_restart();
}

// what others send to the device: d/<sender>/to/<device>/<what>
static void
on_message (const char *from, const char *what, const uint8_t *data, size_t len, void *ctx) {
  (void) ctx;
  printf("BOAT|message from %.12s... (%s): %.*s\n", from, what, (int) len, (const char *) data);
  boat_device_send(from, "ack", data, len);
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
  setting("network", network, sizeof(network), CONFIG_BOAT_NETWORK);
  setting("verifiers", verifiers, sizeof(verifiers), CONFIG_BOAT_VERIFIERS);
  setting("readers", readers, sizeof(readers), CONFIG_BOAT_READERS);

  // Wi-Fi: the network set over Improv and kept in NVS; a developer's build
  // has a default one (sdkconfig.wifi)
  boat_wifi_config_t wifi = {
    .nvs_namespace = "boat_wifi",
    .firmware = "boat_device_min",
    .device_name = "BoAT device",
#ifdef CONFIG_EXAMPLE_WIFI_SSID
    .ssid = CONFIG_EXAMPLE_WIFI_SSID,
    .password = CONFIG_EXAMPLE_WIFI_PASSWORD,
#endif
    .on_line = on_line,
  };
  ESP_ERROR_CHECK(boat_wifi_start(&wifi));
  boat_wifi_wait(portMAX_DELAY);

  boat_device_config_t cfg = {
    .nvs_namespace = DEVICE_NS,
    .network = network[0] ? network : NULL,
    .verifiers = verifiers[0] ? verifiers : NULL,
    .readers = readers[0] ? readers : NULL,
    .on_message = on_message,
  };
  ESP_ERROR_CHECK(boat_device_start(&cfg));
  printf("BOAT|device %s\n", boat_device_key());
  show();

  bool sealed = readers[0] != '\0';
  for (unsigned n = 0;; n++) {
    vTaskDelay(pdMS_TO_TICKS(CONFIG_BOAT_INTERVAL * 1000));
    char reading[96];
    int len = snprintf(reading, sizeof(reading), "{\"n\":%u,\"uptime\":%u,\"heap\":%u}", n, (unsigned) (esp_timer_get_time() / 1000000), (unsigned) heap_caps_get_free_size(MALLOC_CAP_8BIT));
    err = sealed ? boat_device_publish_sealed("telemetry", reading, len) : boat_device_publish("telemetry", reading, len);
    boat_device_stats_t st;
    boat_device_get_stats(&st);
    printf("BOAT|reading %u %s: %s; receipts %lu ok, %lu bad\n", n, sealed ? "sealed" : "signed", esp_err_to_name(err), (unsigned long) st.receipts_ok, (unsigned long) st.receipts_bad);
  }
}
