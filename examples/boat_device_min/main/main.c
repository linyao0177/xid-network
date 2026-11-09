// The smallest BoAT device: a reading every few seconds, signed (and sealed
// to its readers when CONFIG_BOAT_READERS is set), on the BoAT network of
// staked nodes. Everything else is components/boat_device.

#include <stdio.h>

#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "protocol_examples_common.h"

#include "boat_device.h"

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
  ESP_ERROR_CHECK(example_connect());

  boat_device_config_t cfg = {
    .nvs_namespace = "boat_min",
    .verifiers = CONFIG_BOAT_VERIFIERS,
    .readers = CONFIG_BOAT_READERS,
    .on_message = on_message,
  };
  ESP_ERROR_CHECK(boat_device_start(&cfg));
  printf("BOAT|device %s\n", boat_device_key());

  bool sealed = CONFIG_BOAT_READERS[0] != '\0';
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
