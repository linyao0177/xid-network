// MQTT over HyperDHT: an ESP32 device on a network of MQTT nodes anyone can run.
//
// - The device's key pair comes from a seed kept in NVS. Its public key is its
//   identity: the node checks it in the Noise handshake, so there is no
//   password, and only this device may publish under d/<its key>/.
// - esp-mqtt runs unchanged; components/hdht_mqtt gives it a transport that
//   looks the network up on HyperDHT and dials a node by public key.
// - Every few seconds the device publishes telemetry to d/<key>/telemetry.
//   It subscribes to its inbox, d/+/to/<key>/#, where the + is the key of
//   whoever sent the message (the node guarantees it), and acknowledges each
//   message to its sender.
// - Telemetry is signed with the device key (CONFIG_MQTT_P2P_SIGN), so an app
//   can check it whatever node or bridge it came through.
// - Each time it connects, the device puts its record on the DHT naming that
//   node as its home: {"v":1,"did":"did:mw:<key>","mqtt":"<node key>"}. A node
//   that gets a subscription to the device follows it there, and apps send it
//   messages at its home (packages/boat-mqtt-node).

#include <stdio.h>
#include <string.h>

#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mqtt_client.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "protocol_examples_common.h"

#include "hdht.h"
#include "hdht_mqtt.h"

static uv_loop_t loop;
static hdht_t dht;
static uint8_t seed[32];
static uint8_t pk[32], sk[64]; // sk signs telemetry and the record
static char me[65]; // our public key in hex
static uint32_t boot; // signed sequence numbers: boot << 32 | count
static uv_async_t home_async;
static uv_timer_t republish;
static uint8_t home[32];       // set on esp-mqtt's task, read on the hdht task
static volatile bool home_set;
static uint64_t record_seq;
static esp_mqtt_client_handle_t mqtt;
static esp_transport_handle_t transport;
static volatile bool connected;

// Loads the 32-byte key seed from NVS, creating it on first boot, and counts
// boots (for rising sequence numbers).
static esp_err_t
load_seed (uint8_t out[32]) {
  nvs_handle_t nvs;
  esp_err_t err = nvs_open("mqtt_p2p", NVS_READWRITE, &nvs);
  if (err != ESP_OK) return err;
  size_t len = 32;
  err = nvs_get_blob(nvs, "seed", out, &len);
  if (err == ESP_ERR_NVS_NOT_FOUND) {
    randombytes_buf(out, 32);
    err = nvs_set_blob(nvs, "seed", out, 32);
  }
  nvs_get_u32(nvs, "boot", &boot);
  boot++;
  nvs_set_u32(nvs, "boot", boot);
  nvs_get_u64(nvs, "rec_seq", &record_seq);
  if (err == ESP_OK) err = nvs_commit(nvs);
  nvs_close(nvs);
  return err;
}

// the hdht task: our record, naming our home node

static void
on_put (hdht_t *d, int status, unsigned stored, void *data) {
  (void) d;
  (void) data;
  printf("MQTT|home record put status=%d nodes=%u seq=%llu\n", status, stored, (unsigned long long) record_seq);
}

static void
put_record (void) {
  char node[65], value[200];
  sodium_bin2hex(node, sizeof(node), home, 32);
  int len = snprintf(value, sizeof(value), "{\"v\":1,\"did\":\"did:mw:%s\",\"mqtt\":\"%s\"}", me, node);
  record_seq++;
  nvs_handle_t nvs;
  if (nvs_open("mqtt_p2p", NVS_READWRITE, &nvs) == ESP_OK) {
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
  if (!home_set || (once && memcmp(published, home, 32) == 0)) return; // the same home again
  memcpy(published, home, 32);
  once = true;
  put_record();
}

static void
on_republish (uv_timer_t *t) { // records live 48 h on the DHT
  (void) t;
  if (home_set) put_record();
}

static unsigned
uptime_s (void) {
  return (unsigned) (esp_timer_get_time() / 1000000);
}

// esp-mqtt's task
static void
on_mqtt (void *arg, esp_event_base_t base, int32_t id, void *data) {
  (void) arg;
  (void) base;
  esp_mqtt_event_handle_t e = data;
  char topic[200];

  switch ((esp_mqtt_event_id_t) id) {
  case MQTT_EVENT_CONNECTED: {
    connected = true;
    hdht_mqtt_info_t info;
    hdht_mqtt_get_info(transport, &info);
    char node[17];
    sodium_bin2hex(node, sizeof(node), info.node, 8);
    printf("MQTT|connected node=%s... found=%u lookup_ms=%u connect_ms=%u relayed=%d connects=%u\n", node, (unsigned) info.nodes_found, (unsigned) info.lookup_ms, (unsigned) info.connect_ms, info.relayed, (unsigned) info.connects);
    snprintf(topic, sizeof(topic), "d/+/to/%s/#", me);
    esp_mqtt_client_subscribe(mqtt, topic, 1);
    memcpy(home, info.node, 32);
    home_set = true;
    uv_async_send(&home_async); // the record is put on the hdht task
    break;
  }
  case MQTT_EVENT_DISCONNECTED:
    connected = false;
    printf("MQTT|disconnected\n");
    break;
  case MQTT_EVENT_SUBSCRIBED:
    printf("MQTT|subscribed to the inbox\n");
    break;
  case MQTT_EVENT_DATA: {
    // d/<sender>/to/<me>/<rest>
    int n = e->topic_len < (int) sizeof(topic) - 1 ? e->topic_len : (int) sizeof(topic) - 1;
    memcpy(topic, e->topic, n);
    topic[n] = 0;
    if (n < 2 + 64 + 4 || strncmp(topic, "d/", 2) != 0) break;
    char sender[65];
    memcpy(sender, topic + 2, 64);
    sender[64] = 0;
    printf("MQTT|message from=%.12s... topic=%s payload=%.*s\n", sender, topic + 2 + 64 + 1, e->data_len, e->data);

    char reply_topic[200], reply[160];
    snprintf(reply_topic, sizeof(reply_topic), "d/%s/to/%s/ack", me, sender);
    int len = snprintf(reply, sizeof(reply), "ack:%.*s", e->data_len > 100 ? 100 : e->data_len, e->data);
    esp_mqtt_client_publish(mqtt, reply_topic, reply, len, 1, 0);
    break;
  }
  case MQTT_EVENT_ERROR:
    printf("MQTT|error type=%d\n", e->error_handle ? e->error_handle->error_type : -1);
    break;
  default:
    break;
  }
}

// another task: never calls hdht; esp-mqtt hands the bytes to the hdht task
static void
telemetry_task (void *arg) {
  (void) arg;
  char topic[100], msg[128];
  uint8_t sealed[128 + HDHT_MQTT_SIGNED_OVERHEAD];
  snprintf(topic, sizeof(topic), "d/%s/telemetry", me);
  unsigned seq = 0;
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(CONFIG_MQTT_P2P_INTERVAL * 1000));
    if (!connected) continue;
    int len = snprintf(msg, sizeof(msg), "{\"seq\":%u,\"uptime\":%u,\"heap\":%u}", seq, uptime_s(), (unsigned) heap_caps_get_free_size(MALLOC_CAP_8BIT));
#if CONFIG_MQTT_P2P_SIGN
    int64_t t0 = esp_timer_get_time();
    int n = hdht_mqtt_sign(sk, topic, ((uint64_t) boot << 32) | seq, (const uint8_t *) msg, (size_t) len, sealed, sizeof(sealed));
    unsigned sign_us = (unsigned) (esp_timer_get_time() - t0);
    int id = esp_mqtt_client_publish(mqtt, topic, (const char *) sealed, n, 1, 0);
    printf("MQTT|telemetry seq=%u msg_id=%d signed in %u us\n", seq++, id, sign_us);
#else
    int id = esp_mqtt_client_publish(mqtt, topic, msg, len, 1, 0);
    printf("MQTT|telemetry seq=%u msg_id=%d\n", seq++, id);
#endif
  }
}

// the hdht task from here

static void
on_ready (hdht_t *d, int status) {
  printf("bootstrapped (status %d, %u nodes)\n", status, d->table_len);

  transport = hdht_mqtt_transport_new(d, NULL);
  if (transport == NULL) {
    printf("hdht_mqtt_transport_new failed\n");
    return;
  }
  esp_mqtt_client_config_t cfg = {
    .broker.address.hostname = CONFIG_MQTT_P2P_NODE,
    .network.transport = transport,
    .network.timeout_ms = 30000, // a lookup and a holepunch, not a TCP handshake
    .network.reconnect_timeout_ms = 5000,
    .credentials.client_id = me, // the node wants it to start with our key
    .session.keepalive = 60,
  };
  mqtt = esp_mqtt_client_init(&cfg);
  esp_mqtt_client_register_event(mqtt, ESP_EVENT_ANY_ID, on_mqtt, NULL);
  esp_mqtt_client_start(mqtt);
  printf("MQTT|starting, node %s\n", CONFIG_MQTT_P2P_NODE);

  xTaskCreate(telemetry_task, "telemetry", 3072, NULL, 4, NULL);
}

static void
hdht_task (void *arg) {
  (void) arg;
  uv_loop_init(&loop);

  hdht_opts_t opts = { .seed = seed }; // the default key pair: our identity on the nodes
  if (hdht_init(&dht, &loop, &opts) != 0) {
    printf("hdht_init failed\n");
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

void
app_main (void) {
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    err = nvs_flash_init();
  }
  ESP_ERROR_CHECK(err);
  if (sodium_init() < 0) return;

  ESP_ERROR_CHECK(load_seed(seed));
  hdht_keypair(pk, sk, seed);
  sodium_bin2hex(me, sizeof(me), pk, 32);
  printf("MQTT|device key %s\n", me);

  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  ESP_ERROR_CHECK(example_connect());

  xTaskCreate(hdht_task, "hdht", 20480, NULL, 5, NULL);
}
