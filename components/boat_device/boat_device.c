// boat_device (see include/boat_device.h)

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mqtt_client.h"
#include "nvs.h"

#include "boat_device.h"
#include "hdht.h"
#include "hdht_mqtt.h"

static const char *TAG = "boat_device";

#define ROTATE_EVERY 1000 // sealed messages under one data key

static boat_device_config_t cfg;
static char ns[16];
static uv_loop_t loop;
static hdht_t dht;
static uint8_t seed[32], pk[32], sk[64];
static char me[65];
static uint32_t boot;
static uint64_t record_seq;
static esp_transport_handle_t transport;
static esp_mqtt_client_handle_t mqtt;
static volatile bool connected, started;
static uv_async_t home_async;
static uv_timer_t republish;
static uint8_t home[32];
static volatile bool home_set;
static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
static uint32_t count;         // signed messages this boot (the low half of seq)
static uint64_t last_seq;
static boat_device_stats_t stats;

// sealed readings
static uint8_t readers[BOAT_SEAL_MAX_READERS][32];
static size_t readers_len;
static uint8_t data_key[32];
static uint32_t key_id, sealed_count;
static uint8_t envelope[BOAT_SEAL_ENVELOPE_SIZE(BOAT_SEAL_MAX_READERS)];
static int envelope_len;

static void
load_state (void) {
  nvs_handle_t nvs;
  if (nvs_open(ns, NVS_READWRITE, &nvs) != ESP_OK) return;
  size_t len = 32;
  if (nvs_get_blob(nvs, "seed", seed, &len) != ESP_OK) {
    randombytes_buf(seed, 32);
    nvs_set_blob(nvs, "seed", seed, 32);
  }
  nvs_get_u32(nvs, "boot", &boot);
  boot++;
  nvs_set_u32(nvs, "boot", boot);
  nvs_get_u64(nvs, "rec_seq", &record_seq);
  nvs_commit(nvs);
  nvs_close(nvs);
}

static size_t
parse_keys (const char *csv, uint8_t (*out)[32], size_t max) {
  size_t n = 0;
  const char *p = csv ? csv : "";
  while (strlen(p) >= 64 && n < max) {
    if (sodium_hex2bin(out[n], 32, p, 64, NULL, NULL, NULL) != 0) break;
    n++;
    p += 64;
    if (*p == ',') p++;
  }
  return n;
}

// a new data key, and its envelope for the readers
static void
new_data_key (void) {
  randombytes_buf(data_key, 32);
  key_id = ((boot & 0xffff) << 16) | ((key_id + 1) & 0xffff);
  sealed_count = 0;
  envelope_len = boat_seal_envelope(key_id, data_key, (const uint8_t (*)[32]) readers, readers_len, envelope, sizeof(envelope));
}

// ---- the hdht task: the DID record naming the node we are on ----

static void
on_put (hdht_t *d, int status, unsigned stored, void *data) {
  (void) d;
  (void) data;
  ESP_LOGI(TAG, "record put: status %d, %u nodes, seq %llu", status, stored, (unsigned long long) record_seq);
}

static void
put_record (void) {
  char node[65], value[200];
  sodium_bin2hex(node, sizeof(node), home, 32);
  int len = snprintf(value, sizeof(value), "{\"v\":1,\"did\":\"did:mw:%s\",\"mqtt\":\"%s\"}", me, node);
  record_seq++;
  nvs_handle_t nvs;
  if (nvs_open(ns, NVS_READWRITE, &nvs) == ESP_OK) {
    nvs_set_u64(nvs, "rec_seq", record_seq);
    nvs_commit(nvs);
    nvs_close(nvs);
  }
  hdht_mutable_put(&dht, pk, sk, record_seq, (const uint8_t *) value, (size_t) len, on_put, NULL);
}

static void
on_home (uv_async_t *h) {
  (void) h;
  static uint8_t published[32];
  static bool once;
  if (!home_set || (once && memcmp(published, home, 32) == 0)) return;
  memcpy(published, home, 32);
  once = true;
  put_record();
}

static void
on_republish (uv_timer_t *t) { // records live 48 h on the DHT
  (void) t;
  if (home_set) put_record();
}

// ---- esp-mqtt's task ----

static esp_err_t publish_signed (const char *name, const uint8_t *data, size_t len, bool retain);

static void
on_mqtt (void *arg, esp_event_base_t base, int32_t id, void *data) {
  (void) arg;
  (void) base;
  esp_mqtt_event_handle_t e = data;
  char topic[200];
  switch ((esp_mqtt_event_id_t) id) {
  case MQTT_EVENT_CONNECTED: {
    connected = true;
    stats.connects++;
    hdht_mqtt_info_t info;
    hdht_mqtt_get_info(transport, &info);
    snprintf(topic, sizeof(topic), "d/+/to/%s/#", me);
    esp_mqtt_client_subscribe(mqtt, topic, 1);
    memcpy(home, info.node, 32);
    home_set = true;
    uv_async_send(&home_async); // the record is put on the hdht task
    char node[65];
    sodium_bin2hex(node, sizeof(node), info.node, 32);
    ESP_LOGI(TAG, "connected to node %.16s... in %u ms%s", node, (unsigned) info.connect_ms, info.relayed ? " (relayed)" : "");
    if (envelope_len > 0) { // the readers' key, where nodes keep it
      char name[24];
      snprintf(name, sizeof(name), "keys/%08lx", (unsigned long) key_id);
      publish_signed(name, envelope, (size_t) envelope_len, true);
    }
    if (cfg.on_connected) cfg.on_connected(node, cfg.ctx);
    break;
  }
  case MQTT_EVENT_DISCONNECTED:
    connected = false;
    ESP_LOGI(TAG, "disconnected");
    break;
  case MQTT_EVENT_DATA: {
    // d/<sender>/to/<me>/<what>
    int n = e->topic_len < (int) sizeof(topic) - 1 ? e->topic_len : (int) sizeof(topic) - 1;
    memcpy(topic, e->topic, n);
    topic[n] = 0;
    if (n < 2 + 64 + 4 + 64 + 2 || strncmp(topic, "d/", 2) != 0) break;
    char sender[65];
    memcpy(sender, topic + 2, 64);
    sender[64] = 0;
    const char *what = topic + 2 + 64 + 4 + 64 + 1;
    hdht_mqtt_info_t info;
    hdht_mqtt_get_info(transport, &info);
    char node_hex[65];
    sodium_bin2hex(node_hex, sizeof(node_hex), info.node, 32);
    if (strcmp(sender, node_hex) == 0 && strcmp(what, "receipt") == 0) {
      // the node's signed word on what it got from us this boot
      hdht_mqtt_receipt_t r;
      uint64_t covered = 0, beyond = 0, lo = (uint64_t) boot << 32;
      bool ok = hdht_mqtt_receipt_open(info.node, pk, e->data, e->data_len, &r) == 0 &&
                hdht_mqtt_receipt_check(e->data, e->data_len, lo, last_seq, &covered, &beyond) == 0 && beyond == 0;
      if (ok) stats.receipts_ok++;
      else stats.receipts_bad++;
      break;
    }
    if (cfg.on_message) cfg.on_message(sender, what, (const uint8_t *) e->data, (size_t) e->data_len, cfg.ctx);
    break;
  }
  default:
    break;
  }
}

static void
start_mqtt (void) {
  if (mqtt) return;
  esp_mqtt_client_config_t c = {
    .broker.address.hostname = cfg.network ? cfg.network : "boat-mqtt",
    .network.transport = transport,
    .network.timeout_ms = 30000, // a lookup and a holepunch, not a TCP handshake
    .network.reconnect_timeout_ms = 5000,
    .credentials.client_id = me, // the node wants it to start with our key
    .session.keepalive = 60,
    .buffer.size = 1536,
  };
  mqtt = esp_mqtt_client_init(&c);
  esp_mqtt_client_register_event(mqtt, ESP_EVENT_ANY_ID, on_mqtt, NULL);
  esp_mqtt_client_start(mqtt);
}

static void
on_list_ready (bool taken, void *data) {
  (void) taken;
  (void) data;
  start_mqtt(); // without a list, the transport looks the network name up
}

static void
on_ready (hdht_t *d, int status) {
  ESP_LOGI(TAG, "bootstrapped (status %d, %u nodes)", status, d->table_len);
  transport = hdht_mqtt_transport_new(d, NULL);
  if (transport == NULL) {
    ESP_LOGE(TAG, "no memory for the transport");
    return;
  }
  uint32_t pick = ((uint32_t) pk[0] << 24) | ((uint32_t) pk[1] << 16) | ((uint32_t) pk[2] << 8) | pk[3];
  if (hdht_mqtt_nodelist_keep(d, transport, ns, cfg.verifiers, pick, on_list_ready, NULL) != 0) start_mqtt();
}

static void
hdht_task (void *arg) {
  (void) arg;
  uv_loop_init(&loop);
  hdht_opts_t opts = { .seed = seed };
  if (hdht_init(&dht, &loop, &opts) != 0) {
    ESP_LOGE(TAG, "hdht_init failed");
    vTaskDelete(NULL);
  }
  sodium_memzero(seed, sizeof(seed));
  esp_netif_ip_info_t ip;
  esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
  if (netif && esp_netif_get_ip_info(netif, &ip) == ESP_OK) hdht_add_local_address(&dht, (const uint8_t *) &ip.ip.addr);
  uv_async_init(&loop, &home_async, on_home);
  uv_timer_init(&loop, &republish);
  uv_timer_start(&republish, on_republish, 12 * 3600 * 1000, 12 * 3600 * 1000);
  hdht_bootstrap(&dht, on_ready);
  uv_run(&loop, UV_RUN_DEFAULT);
}

esp_err_t
boat_device_start (const boat_device_config_t *c) {
  if (started) return ESP_ERR_INVALID_STATE;
  if (c == NULL || c->nvs_namespace == NULL) return ESP_ERR_INVALID_ARG;
  if (sodium_init() < 0) return ESP_FAIL;
  cfg = *c;
  snprintf(ns, sizeof(ns), "%s", c->nvs_namespace);
  load_state();
  hdht_keypair(pk, sk, seed);
  sodium_bin2hex(me, sizeof(me), pk, 32);
  readers_len = parse_keys(c->readers, readers, BOAT_SEAL_MAX_READERS);
  if (readers_len) new_data_key();
  started = true;
  ESP_LOGI(TAG, "device %s, boot %lu, %u reader(s)", me, (unsigned long) boot, (unsigned) readers_len);
  return xTaskCreate(hdht_task, "hdht", c->hdht_stack ? c->hdht_stack : 20480, NULL, 5, NULL) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}

const char *
boat_device_key (void) {
  return me;
}

bool
boat_device_connected (void) {
  return connected;
}

static esp_err_t
publish_signed (const char *name, const uint8_t *data, size_t len, bool retain) {
  if (!connected) return ESP_ERR_INVALID_STATE;
  char topic[100];
  snprintf(topic, sizeof(topic), "d/%s/%s", me, name);
  uint8_t *msg = malloc(len + HDHT_MQTT_SIGNED_OVERHEAD);
  if (msg == NULL) return ESP_ERR_NO_MEM;
  taskENTER_CRITICAL(&mux);
  uint64_t seq = ((uint64_t) boot << 32) | count++;
  taskEXIT_CRITICAL(&mux);
  int n = hdht_mqtt_sign(sk, topic, seq, data, len, msg, len + HDHT_MQTT_SIGNED_OVERHEAD);
  int id = n < 0 ? -1 : esp_mqtt_client_publish(mqtt, topic, (const char *) msg, n, 1, retain);
  free(msg);
  if (id < 0) return ESP_FAIL;
  last_seq = seq;
  stats.published++;
  return ESP_OK;
}

esp_err_t
boat_device_publish (const char *name, const void *data, size_t len) {
  return publish_signed(name, data, len, false);
}

esp_err_t
boat_device_publish_sealed (const char *name, const void *data, size_t len) {
  if (readers_len == 0 || envelope_len <= 0) return ESP_ERR_INVALID_STATE;
  if (sealed_count >= ROTATE_EVERY) {
    new_data_key();
    char kname[24];
    snprintf(kname, sizeof(kname), "keys/%08lx", (unsigned long) key_id);
    publish_signed(kname, envelope, (size_t) envelope_len, true);
  }
  char topic[100];
  snprintf(topic, sizeof(topic), "d/%s/%s", me, name);
  uint8_t *sealed = malloc(len + BOAT_SEAL_OVERHEAD);
  if (sealed == NULL) return ESP_ERR_NO_MEM;
  int n = boat_seal_encrypt(data_key, key_id, topic, data, len, sealed, len + BOAT_SEAL_OVERHEAD);
  esp_err_t err = n < 0 ? ESP_FAIL : publish_signed(name, sealed, (size_t) n, false);
  free(sealed);
  if (err == ESP_OK) sealed_count++;
  return err;
}

esp_err_t
boat_device_send (const char *recipient_hex, const char *what, const void *data, size_t len) {
  if (!connected) return ESP_ERR_INVALID_STATE;
  char topic[200];
  snprintf(topic, sizeof(topic), "d/%s/to/%.64s/%s", me, recipient_hex, what);
  return esp_mqtt_client_publish(mqtt, topic, data, (int) len, 1, 0) < 0 ? ESP_FAIL : ESP_OK;
}

void
boat_device_get_stats (boat_device_stats_t *out) {
  *out = stats;
}
